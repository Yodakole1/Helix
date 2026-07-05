//! Mail import and bulk export -- the migration path in and out of Helix.
//! People switching clients arrive with archives (Thunderbird profiles,
//! "Download your data" dumps, stray .eml files); people leaving -- or
//! just backing up -- need their mailbox back out as files. Both
//! directions speak the two formats everything else speaks: **mbox**
//! (one file, many messages, the Thunderbird/Google-Takeout format) and
//! **EML** (one RFC 5322 message per file).
//!
//! Import APPENDs into a folder on the IMAP server rather than into the
//! local cache: the server copy is the source of truth everywhere else
//! in this codebase, and a cache-only import would vanish on the next
//! cache clear and never show up on the user's other devices. The flip
//! side: import (and export) are IMAP-only -- POP3 has no APPEND and no
//! folders, so those accounts get a clear error instead of a half-baked
//! local approximation.
//!
//! The mbox dialect here is mboxrd-flavored: on write, any body line
//! matching `^>*From ` gets one `>` prepended; on read, one `>` is
//! stripped from such lines, and a `From ` line following a blank line
//! is a message separator. That round-trips our own files exactly and
//! reads Thunderbird/Takeout files correctly.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

use futures::TryStreamExt;
use serde::Serialize;

use crate::cache;
use crate::imap;

/// Splits a stream into RFC 5322 messages, CRLF-normalized so they can go
/// straight into IMAP APPEND. Streaming -- holds one message in memory at
/// a time, because Takeout mboxes run to gigabytes.
pub(crate) struct MboxReader<R: BufRead> {
    reader: R,
    /// A separator was consumed at the end of the previous call, so the
    /// next call is already inside a message even before reading a line.
    inside_message: bool,
    /// Nothing read yet -- used to reject files that don't start with a
    /// `From ` separator line (i.e. aren't mbox at all).
    at_start: bool,
}

impl<R: BufRead> MboxReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        MboxReader { reader, inside_message: false, at_start: true }
    }

    pub(crate) fn next_message(&mut self) -> Result<Option<Vec<u8>>, String> {
        let mut message: Vec<u8> = Vec::new();
        let mut prev_blank = true;

        loop {
            let mut line: Vec<u8> = Vec::new();
            let read = self
                .reader
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("could not read mbox file: {e}"))?;

            if read == 0 {
                // EOF: the last message has no trailing separator.
                if self.inside_message && !message.is_empty() {
                    self.inside_message = false;
                    trim_trailing_blank_line(&mut message);
                    return Ok(Some(message));
                }
                return Ok(None);
            }

            while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
                line.pop();
            }

            let is_separator = prev_blank && line.starts_with(b"From ");

            if self.at_start {
                self.at_start = false;
                if !is_separator {
                    return Err(
                        "this doesn't look like an mbox file (it doesn't start with a 'From ' separator line)"
                            .to_string(),
                    );
                }
            }

            if is_separator {
                if self.inside_message {
                    // End of the current message; the separator we just
                    // consumed opens the next one.
                    trim_trailing_blank_line(&mut message);
                    return Ok(Some(message));
                }
                self.inside_message = true;
                continue;
            }

            prev_blank = line.is_empty();
            message.extend_from_slice(&unstuff(&line));
            message.extend_from_slice(b"\r\n");
        }
    }
}

/// mboxrd unstuffing: `>From ` -> `From `, `>>From ` -> `>From `, etc.
fn unstuff(line: &[u8]) -> Vec<u8> {
    let quotes = line.iter().take_while(|&&b| b == b'>').count();
    if quotes >= 1 && line[quotes..].starts_with(b"From ") {
        return line[1..].to_vec();
    }
    line.to_vec()
}

/// The write-side counterpart: does this line need a `>` prepended so it
/// can't be mistaken for a separator (or lose a quoting level) on read?
fn needs_stuffing(line: &[u8]) -> bool {
    let after_quotes: &[u8] = &line[line.iter().take_while(|&&b| b == b'>').count()..];
    after_quotes.starts_with(b"From ")
}

/// A message ends with the separator's leading blank line, which is mbox
/// framing, not message content.
fn trim_trailing_blank_line(message: &mut Vec<u8>) {
    if message.ends_with(b"\r\n\r\n") {
        message.truncate(message.len() - 2);
    }
}

/// Appends one message to an mbox file: `From ` separator, LF line
/// endings, From-stuffed body, blank-line terminator.
pub(crate) fn write_mbox_message<W: Write>(writer: &mut W, raw: &[u8]) -> Result<(), String> {
    // The separator's addr/date fields carry no information any modern
    // reader uses (the real ones are in the headers); Thunderbird itself
    // writes "From - <date>".
    writer
        .write_all(b"From - Thu Jan  1 00:00:00 1970\n")
        .map_err(|e| format!("could not write mbox: {e}"))?;

    // Strip one trailing newline before splitting -- otherwise the final
    // empty slice split() yields for newline-terminated input would write
    // a spurious blank line that grows the message on every round trip.
    let raw = raw
        .strip_suffix(b"\n")
        .map(|rest| rest.strip_suffix(b"\r").unwrap_or(rest))
        .unwrap_or(raw);

    for line in raw.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if needs_stuffing(line) {
            writer.write_all(b">").map_err(|e| format!("could not write mbox: {e}"))?;
        }
        writer.write_all(line).map_err(|e| format!("could not write mbox: {e}"))?;
        writer.write_all(b"\n").map_err(|e| format!("could not write mbox: {e}"))?;
    }

    writer.write_all(b"\n").map_err(|e| format!("could not write mbox: {e}"))
}

/// LF -> CRLF for IMAP APPEND (RFC 3501 requires CRLF). Already-CRLF
/// input passes through unchanged.
pub(crate) fn normalize_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for line in bytes.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        out.extend_from_slice(line);
        out.extend_from_slice(b"\r\n");
    }
    // split() yields one final empty slice for trailing-newline input;
    // drop the extra terminator it produced.
    if bytes.ends_with(b"\n") || bytes.is_empty() {
        out.truncate(out.len().saturating_sub(2));
    }
    out
}

fn reject_pop3(account_id: &str) -> Result<(), String> {
    let is_pop3 = cache::open()
        .and_then(|conn| cache::get_account(&conn, account_id))
        .ok()
        .flatten()
        .map(|a| a.incoming_protocol == "pop3")
        .unwrap_or(false);
    if is_pop3 {
        return Err(
            "import/export needs an IMAP account -- POP3 has no folders to import into or export from"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ImportResult {
    pub imported: u32,
    pub failed: u32,
    /// The first APPEND/parse error, so the UI can say *why* instead of
    /// just "3 failed".
    pub first_error: Option<String>,
}

/// Imports every message in an mbox file into `folder` on the account's
/// IMAP server, over one session. Failed messages are counted rather
/// than aborting the run -- one malformed message in a 10-year archive
/// shouldn't strand the other 40,000 -- except for a parse error, which
/// means we've lost framing and every subsequent "message" would be
/// garbage. Imported messages are APPENDed `\Seen`: an archive is by
/// definition mail that was already dealt with.
#[tauri::command]
pub async fn import_mbox(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    path: String,
) -> Result<ImportResult, String> {
    reject_pop3(&account_id)?;

    let file = File::open(&path).map_err(|e| format!("could not open {path}: {e}"))?;
    let mut mbox = MboxReader::new(BufReader::new(file));

    let mut session = imap::login_for_account(&host, port, &account_id).await?;
    let mut result = ImportResult { imported: 0, failed: 0, first_error: None };

    loop {
        match mbox.next_message() {
            Ok(Some(raw)) => {
                match session.append(&folder, Some("(\\Seen)"), None, &raw).await {
                    Ok(()) => result.imported += 1,
                    Err(e) => {
                        result.failed += 1;
                        result
                            .first_error
                            .get_or_insert_with(|| format!("APPEND to {folder} failed: {e}"));
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                // A parse error before anything imported means the file
                // itself is wrong (not mbox at all) -- fail loudly. After
                // successful imports it means lost framing mid-file: keep
                // what landed and report the error.
                if result.imported == 0 && result.failed == 0 {
                    session.logout().await.ok();
                    return Err(e);
                }
                result.failed += 1;
                result.first_error.get_or_insert(e);
                break;
            }
        }
    }

    session.logout().await.ok();
    Ok(result)
}

/// Imports individual .eml files (one RFC 5322 message each) into
/// `folder`, over one session. Same counting posture as `import_mbox`.
#[tauri::command]
pub async fn import_eml_files(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    paths: Vec<String>,
) -> Result<ImportResult, String> {
    reject_pop3(&account_id)?;

    let mut session = imap::login_for_account(&host, port, &account_id).await?;
    let mut result = ImportResult { imported: 0, failed: 0, first_error: None };

    for path in &paths {
        let raw = match std::fs::read(path) {
            Ok(bytes) => normalize_crlf(&bytes),
            Err(e) => {
                result.failed += 1;
                result.first_error.get_or_insert_with(|| format!("could not read {path}: {e}"));
                continue;
            }
        };
        match session.append(&folder, Some("(\\Seen)"), None, &raw).await {
            Ok(()) => result.imported += 1,
            Err(e) => {
                result.failed += 1;
                result.first_error.get_or_insert_with(|| format!("APPEND to {folder} failed: {e}"));
            }
        }
    }

    session.logout().await.ok();
    Ok(result)
}

/// Streams every message in one folder into an mbox file at `dest_path`.
/// EXAMINE, not SELECT, and BODY.PEEK -- exporting a backup must not mark
/// anything read. Returns how many messages were written.
#[tauri::command]
pub async fn export_folder_mbox(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    dest_path: String,
) -> Result<u32, String> {
    reject_pop3(&account_id)?;

    let mut session = imap::login_for_account(&host, port, &account_id).await?;
    let result = export_folder_into(&mut session, &folder, Path::new(&dest_path)).await;
    session.logout().await.ok();
    result
}

async fn export_folder_into(
    session: &mut imap::ImapSession,
    folder: &str,
    dest_path: &Path,
) -> Result<u32, String> {
    let mailbox = session
        .examine(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let file = File::create(dest_path)
        .map_err(|e| format!("could not create {}: {e}", dest_path.display()))?;
    let mut writer = BufWriter::new(file);
    let mut count: u32 = 0;

    if mailbox.exists > 0 {
        let mut stream = session
            .uid_fetch("1:*", "BODY.PEEK[]")
            .await
            .map_err(|e| format!("FETCH failed for {folder}: {e}"))?;
        while let Some(fetch) = stream
            .try_next()
            .await
            .map_err(|e| format!("FETCH failed for {folder}: {e}"))?
        {
            if let Some(body) = fetch.body() {
                write_mbox_message(&mut writer, body)?;
                count += 1;
            }
        }
    }

    writer
        .flush()
        .map_err(|e| format!("could not finish writing {}: {e}", dest_path.display()))?;
    Ok(count)
}

#[derive(Serialize)]
pub struct FolderExport {
    pub folder: String,
    pub messages: u32,
    pub file: String,
}

/// Full-mailbox backup: one mbox file per folder into `dest_dir`.
/// Folders that can't be opened (e.g. \Noselect hierarchy nodes) are
/// skipped with a log line rather than failing the rest of the backup.
#[tauri::command]
pub async fn export_account_mbox(
    account_id: String,
    host: String,
    port: u16,
    dest_dir: String,
) -> Result<Vec<FolderExport>, String> {
    reject_pop3(&account_id)?;

    let dir = Path::new(&dest_dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {dest_dir}: {e}"))?;

    let mut session = imap::login_for_account(&host, port, &account_id).await?;
    let folders = imap::list_folder_names(&mut session).await?;

    let mut exports = Vec::new();
    for folder in folders {
        let file_path = dir.join(format!("{}.mbox", sanitize_filename(&folder)));
        match export_folder_into(&mut session, &folder, &file_path).await {
            Ok(messages) => exports.push(FolderExport {
                folder,
                messages,
                file: file_path.display().to_string(),
            }),
            Err(e) => {
                log::warn!("skipping folder {folder} during export: {e}");
                std::fs::remove_file(&file_path).ok();
            }
        }
    }

    session.logout().await.ok();
    Ok(exports)
}

/// Folder names become file names: path separators and other characters
/// that are illegal or surprising in filenames on any of the three OSes
/// are replaced. "INBOX.Sent" -> "INBOX.Sent", "[Gmail]/Sent Mail" ->
/// "[Gmail]_Sent Mail".
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(mbox: &str) -> Vec<Vec<u8>> {
        let mut reader = MboxReader::new(BufReader::new(mbox.as_bytes()));
        let mut messages = Vec::new();
        while let Some(message) = reader.next_message().expect("mbox should parse") {
            messages.push(message);
        }
        messages
    }

    #[test]
    fn splits_messages_and_normalizes_to_crlf() {
        let mbox = "From alice@example.com Thu Jan  1 00:00:00 2026\n\
                    Subject: one\n\
                    \n\
                    first body\n\
                    \n\
                    From bob@example.com Thu Jan  1 00:00:00 2026\n\
                    Subject: two\n\
                    \n\
                    second body\n";
        let messages = read_all(mbox);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], b"Subject: one\r\n\r\nfirst body\r\n");
        assert_eq!(messages[1], b"Subject: two\r\n\r\nsecond body\r\n");
    }

    #[test]
    fn unstuffs_quoted_from_lines_and_ignores_unquoted_mid_line_from() {
        let mbox = "From - Thu Jan  1 00:00:00 1970\n\
                    Subject: stuffing\n\
                    \n\
                    >From the beginning\n\
                    >>From deeper\n\
                    a line about From headers\n";
        let messages = read_all(mbox);
        assert_eq!(messages.len(), 1);
        let body = String::from_utf8(messages[0].clone()).unwrap();
        assert!(body.contains("\r\nFrom the beginning\r\n"), "got: {body}");
        assert!(body.contains("\r\n>From deeper\r\n"), "got: {body}");
        assert!(body.contains("a line about From headers"), "got: {body}");
    }

    #[test]
    fn a_from_line_mid_paragraph_is_not_a_separator() {
        // "From " only separates after a blank line -- a body line like
        // "From here on..." mid-paragraph must not split the message.
        let mbox = "From - Thu Jan  1 00:00:00 1970\n\
                    Subject: tricky\n\
                    \n\
                    some text\n\
                    From here on this is still the same message\n";
        let messages = read_all(mbox);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn rejects_files_that_are_not_mbox() {
        let mut reader = MboxReader::new(BufReader::new("Subject: I am a bare eml\r\n\r\nhi\r\n".as_bytes()));
        assert!(reader.next_message().is_err());
    }

    #[test]
    fn write_then_read_round_trips_including_from_stuffing() {
        let original: &[u8] =
            b"Subject: round trip\r\n\r\nFrom the top\r\n>From quoted\r\nplain line\r\n";
        let mut mbox: Vec<u8> = Vec::new();
        write_mbox_message(&mut mbox, original).unwrap();
        write_mbox_message(&mut mbox, original).unwrap();

        let mut reader = MboxReader::new(BufReader::new(mbox.as_slice()));
        let first = reader.next_message().unwrap().expect("first message");
        let second = reader.next_message().unwrap().expect("second message");
        assert!(reader.next_message().unwrap().is_none());

        assert_eq!(first, original);
        assert_eq!(second, original);
    }

    #[test]
    fn normalize_crlf_handles_lf_crlf_and_missing_trailing_newline() {
        assert_eq!(normalize_crlf(b"a\nb\n"), b"a\r\nb\r\n");
        assert_eq!(normalize_crlf(b"a\r\nb\r\n"), b"a\r\nb\r\n");
        assert_eq!(normalize_crlf(b"a\nb"), b"a\r\nb\r\n");
        assert_eq!(normalize_crlf(b""), b"");
    }

    #[test]
    fn sanitize_filename_replaces_path_separators() {
        assert_eq!(sanitize_filename("[Gmail]/Sent Mail"), "[Gmail]_Sent Mail");
        assert_eq!(sanitize_filename("INBOX.Sent"), "INBOX.Sent");
        assert_eq!(sanitize_filename("a\\b:c"), "a_b_c");
    }
}
