//! Bulk account provisioning from a plain-text file -- the "I have forty
//! mailboxes on my domain" path that would be miserable to click through
//! one onboarding form at a time. The file is a list of `key: value`
//! blocks, one per account, separated by blank lines (the committed
//! `accounts-import.example.txt` at the repo root is the reference copy
//! users start from). Each account goes through the exact same
//! store-verify-persist-or-roll-back flow as the onboarding form -- this
//! module reuses `account::add_account`/`account::add_pop3_account`
//! directly rather than reimplementing any of it -- and blocks that name
//! no servers at all fall back to `discovery::discover_server_config`,
//! same as the form with "advanced settings" collapsed.
//!
//! The file contains passwords, so it is treated as radioactive: the
//! whole thing is parsed up front (so a syntax error costs nothing), the
//! in-memory copy is zeroized as soon as parsing is done, and once the
//! import has run the file itself is overwritten with zeros and deleted.
//! The overwrite is best-effort scrubbing, not a forensic guarantee --
//! journaling filesystems and SSD wear leveling can keep stale copies --
//! but it beats leaving a plaintext password list in Downloads. The one
//! case the file survives is a parse error before anything was imported:
//! deleting it there would throw away the user's typing over a typo, so
//! the error message tells them the file (and its passwords) is still on
//! disk instead.

use std::collections::HashMap;
use std::io::Write;

use serde::Serialize;
use zeroize::Zeroize;

use crate::account;
use crate::cache;
use crate::caldav;
use crate::carddav;
use crate::discovery;

/// A filled-in import file is a handful of short lines per account; even a
/// mass provisioning run is a few kilobytes. Anything past this is a
/// mispicked file (an mbox, a log), and reading it into memory -- memory
/// we then have to zeroize -- helps nobody.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, PartialEq)]
enum Incoming {
    /// No host keys in the block: resolve servers from the email address
    /// via `discovery::discover_server_config` at import time.
    Auto,
    Imap { host: String, port: u16, starttls: bool },
    Pop3 { host: String, port: u16 },
}

#[derive(Debug, PartialEq)]
struct SmtpSettings {
    host: String,
    port: u16,
    starttls: bool,
}

#[derive(Debug, PartialEq)]
struct ParsedAccount {
    email: String,
    password: String,
    display_name: Option<String>,
    incoming: Incoming,
    /// `Some` exactly when the block names servers itself; `None` means
    /// `incoming` is `Auto` and SMTP comes from discovery too.
    smtp: Option<SmtpSettings>,
    caldav: bool,
    carddav: bool,
}

impl Drop for ParsedAccount {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// Canonicalizes a key: lowercased, `-` treated as `_`, and the aliases
/// people plausibly type mapped to one name each. `email_adress` is not a
/// typo here -- it's *the user's* likely typo, and rejecting an otherwise
/// perfect file over one missing letter would be pedantry.
fn canonical_key(raw: &str) -> Option<&'static str> {
    let key = raw.trim().to_ascii_lowercase().replace('-', "_");
    Some(match key.as_str() {
        "email" | "email_address" | "email_adress" | "address" => "email",
        "password" => "password",
        "display_name" | "name" => "display_name",
        "imap_host" => "imap_host",
        "imap_port" => "imap_port",
        "imap_starttls" | "imap_use_starttls" => "imap_starttls",
        "pop3_host" => "pop3_host",
        "pop3_port" => "pop3_port",
        "smtp_host" => "smtp_host",
        "smtp_port" => "smtp_port",
        "smtp_starttls" | "smtp_use_starttls" => "smtp_starttls",
        "caldav_state" | "caldav" => "caldav",
        "carddav_state" | "carddav" | "contacts_state" => "carddav",
        _ => return None,
    })
}

fn parse_flag(value: &str, key: &str, line: usize) -> Result<bool, String> {
    match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "yes" | "1" => Ok(true),
        "off" | "false" | "no" | "0" => Ok(false),
        other => Err(format!("line {line}: '{key}' must be on or off, not '{other}'")),
    }
}

fn parse_port(value: &str, key: &str, line: usize) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("line {line}: '{key}' must be a port number between 1 and 65535, not '{value}'"))
}

/// Turns one block's `(line, key, value)` entries into a validated
/// account spec. Strict on purpose: a file full of passwords deserves
/// loud errors over silent guesses, so unknown keys, duplicates, and
/// half-specified server settings are all rejected with the line number.
fn build_account(fields: &[(usize, &'static str, String)]) -> Result<ParsedAccount, String> {
    let block_line = fields.first().map(|(line, _, _)| *line).unwrap_or(0);

    let mut map: HashMap<&'static str, (usize, &str)> = HashMap::new();
    for (line, key, value) in fields {
        if map.insert(key, (*line, value.as_str())).is_some() {
            return Err(format!("line {line}: '{key}' is set twice in the same account block"));
        }
    }
    let value = |key: &str| map.get(key).map(|(_, v)| *v);
    let entry = |key: &str| map.get(key).copied();

    let email = value("email")
        .ok_or_else(|| format!("account block starting at line {block_line}: email_address is missing"))?
        .to_string();
    if email.split('@').filter(|part| !part.is_empty()).count() != 2 {
        return Err(format!(
            "account block starting at line {block_line}: '{email}' doesn't look like an email address"
        ));
    }
    let password = value("password")
        .ok_or_else(|| format!("account block for {email}: password is missing"))?
        .to_string();
    let display_name = value("display_name").map(|name| name.to_string());

    let caldav = match entry("caldav") {
        Some((line, v)) => parse_flag(v, "caldav_state", line)?,
        None => false,
    };
    let carddav = match entry("carddav") {
        Some((line, v)) => parse_flag(v, "carddav_state", line)?,
        None => false,
    };

    // Server settings are all-or-nothing, mirroring discovery.rs's
    // posture: either the block names no servers (full auto-discovery
    // from the address) or it names both the incoming server and SMTP.
    // A dangling port or STARTTLS flag without its host is a sign the
    // user meant something we'd otherwise silently ignore.
    let has_imap = value("imap_host").is_some();
    let has_pop3 = value("pop3_host").is_some();
    if has_imap && has_pop3 {
        return Err(format!(
            "account block for {email}: sets both imap_host and pop3_host -- pick one incoming protocol"
        ));
    }
    for (key, needs) in [
        ("imap_port", "imap_host"),
        ("imap_starttls", "imap_host"),
        ("pop3_port", "pop3_host"),
        ("smtp_port", "smtp_host"),
        ("smtp_starttls", "smtp_host"),
    ] {
        if let Some((line, _)) = entry(key) {
            if value(needs).is_none() {
                return Err(format!("line {line}: '{key}' is set but '{needs}' is not"));
            }
        }
    }

    let smtp = match entry("smtp_host") {
        Some((_, host)) => {
            if !has_imap && !has_pop3 {
                return Err(format!(
                    "account block for {email}: smtp_host is set but no imap_host or pop3_host -- \
                     name both servers, or neither to auto-discover"
                ));
            }
            let starttls = match entry("smtp_starttls") {
                Some((line, v)) => parse_flag(v, "smtp_starttls", line)?,
                None => false,
            };
            let port = match entry("smtp_port") {
                Some((line, v)) => parse_port(v, "smtp_port", line)?,
                None => if starttls { 587 } else { 465 },
            };
            Some(SmtpSettings { host: host.to_string(), port, starttls })
        }
        None => {
            if has_imap || has_pop3 {
                return Err(format!(
                    "account block for {email}: an incoming host is set but smtp_host is not -- \
                     name both servers, or neither to auto-discover"
                ));
            }
            None
        }
    };

    let incoming = if has_imap {
        let starttls = match entry("imap_starttls") {
            Some((line, v)) => parse_flag(v, "imap_starttls", line)?,
            None => false,
        };
        let port = match entry("imap_port") {
            Some((line, v)) => parse_port(v, "imap_port", line)?,
            None => if starttls { 143 } else { 993 },
        };
        Incoming::Imap { host: value("imap_host").unwrap().to_string(), port, starttls }
    } else if has_pop3 {
        let port = match entry("pop3_port") {
            Some((line, v)) => parse_port(v, "pop3_port", line)?,
            None => 995,
        };
        Incoming::Pop3 { host: value("pop3_host").unwrap().to_string(), port }
    } else {
        Incoming::Auto
    };

    Ok(ParsedAccount { email, password, display_name, incoming, smtp, caldav, carddav })
}

/// Parses the whole file into account specs. Blocks are separated by
/// blank lines or a `---` divider; `#` and `;` lines are comments; each
/// setting line is `key: value` (or `key = value`). Everything is
/// validated before any network or keychain work happens, so a broken
/// file fails as a whole with a line number rather than half-importing.
fn parse_accounts(input: &str) -> Result<Vec<ParsedAccount>, String> {
    let mut accounts: Vec<ParsedAccount> = Vec::new();
    let mut block: Vec<(usize, &'static str, String)> = Vec::new();

    for (idx, raw) in input.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim();

        let is_divider = line.len() >= 3 && line.chars().all(|c| c == '-');
        if line.is_empty() || is_divider {
            if !block.is_empty() {
                accounts.push(build_account(&block)?);
                block.clear();
            }
            continue;
        }
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        let sep = line
            .find([':', '='])
            .ok_or_else(|| format!("line {line_no}: expected 'key: value', got '{line}'"))?;
        let raw_key = &line[..sep];
        let value = line[sep + 1..].trim().to_string();

        let key = canonical_key(raw_key).ok_or_else(|| {
            format!(
                "line {line_no}: unknown setting '{}' -- see accounts-import.example.txt for the supported keys",
                raw_key.trim()
            )
        })?;
        if value.is_empty() {
            return Err(format!("line {line_no}: '{}' has no value", raw_key.trim()));
        }
        block.push((line_no, key, value));
    }
    if !block.is_empty() {
        accounts.push(build_account(&block)?);
    }

    // The same address twice is almost certainly a copy-paste slip; the
    // second block would just report "skipped, already exists" after the
    // first one imported, which reads like a bug. Fail up front instead.
    let mut seen: Vec<&str> = Vec::new();
    for account in &accounts {
        if seen.iter().any(|s| s.eq_ignore_ascii_case(&account.email)) {
            return Err(format!("{} appears in more than one account block", account.email));
        }
        seen.push(&account.email);
    }

    Ok(accounts)
}

#[derive(Debug, Serialize)]
pub struct AccountImportOutcome {
    pub email: String,
    /// "added", "skipped" (already configured), or "failed".
    pub status: String,
    /// The error for "failed"/"skipped"; for "added", any notes about the
    /// optional CalDAV/CardDAV side (e.g. nothing discovered).
    pub detail: Option<String>,
    pub calendars_added: u32,
    pub address_books_added: u32,
}

#[derive(Debug, Serialize)]
pub struct ImportAccountsReport {
    pub results: Vec<AccountImportOutcome>,
    /// The import file holds plaintext passwords, so it's deleted once
    /// the import has run. If that somehow failed, the frontend must
    /// tell the user to delete it by hand.
    pub file_deleted: bool,
    pub delete_error: Option<String>,
}

/// Best-effort scrub-and-delete: overwrite the file's bytes with zeros,
/// flush to disk, then unlink. See the module comment for why this is
/// scrubbing rather than a guarantee.
fn delete_import_file(path: &str) -> Result<(), String> {
    let len = std::fs::metadata(path)
        .map_err(|e| format!("could not stat {path}: {e}"))?
        .len() as usize;
    let overwrite = std::fs::OpenOptions::new().write(true).open(path).and_then(|mut file| {
        file.write_all(&vec![0u8; len])?;
        file.sync_all()
    });
    if let Err(e) = overwrite {
        // Unlinking still removes the passwords from casual reach, so a
        // failed overwrite shouldn't abort the deletion.
        log::warn!("could not overwrite {path} before deleting: {e}");
    }
    std::fs::remove_file(path).map_err(|e| format!("could not delete {path}: {e}"))
}

/// Probes CalDAV and/or CardDAV for a just-imported account and adds
/// every discovered calendar/address book -- the same thing the
/// onboarding form's services step does, with the same host candidates
/// (the mail domain first for RFC 6764 .well-known discovery, then the
/// mail server, which small hosts often reuse). Best-effort by design: a
/// mailbox that imported fine must not read as "failed" because the
/// provider has no calendar, so problems land in `notes`, not in the
/// account's status.
async fn add_dav_services(
    email: &str,
    password: &str,
    incoming_host: Option<&str>,
    want_caldav: bool,
    want_carddav: bool,
) -> (u32, u32, Vec<String>) {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(domain) = email.split('@').nth(1) {
        candidates.push(domain.to_string());
    }
    if let Some(host) = incoming_host {
        if !host.is_empty() && !candidates.iter().any(|c| c == host) {
            candidates.push(host.to_string());
        }
    }

    let mut calendars_added = 0u32;
    let mut books_added = 0u32;
    let mut notes: Vec<String> = Vec::new();

    // The DAV modules are blocking (reqwest::blocking under the hood), so
    // every call goes through spawn_blocking rather than stalling the
    // async runtime the IMAP verifications share.
    if want_caldav {
        let mut discovered = Vec::new();
        for host in &candidates {
            let (host, user, pass) = (host.clone(), email.to_string(), password.to_string());
            let found = tokio::task::spawn_blocking(move || caldav::discover_caldav_blocking(host, user, pass)).await;
            if let Ok(Ok(calendars)) = found {
                if !calendars.is_empty() {
                    discovered = calendars;
                    break;
                }
            }
        }
        if discovered.is_empty() {
            notes.push("no CalDAV calendar answered with these credentials".to_string());
        }
        for calendar in discovered {
            let (account, user, pass) = (email.to_string(), email.to_string(), password.to_string());
            let added = tokio::task::spawn_blocking(move || {
                caldav::add_caldav_source_blocking(account, calendar.url, user, pass, calendar.display_name, None)
            })
            .await;
            match added {
                Ok(Ok(_)) => calendars_added += 1,
                Ok(Err(e)) => notes.push(format!("a discovered calendar could not be added: {e}")),
                Err(e) => notes.push(format!("a discovered calendar could not be added: {e}")),
            }
        }
    }

    if want_carddav {
        let mut discovered = Vec::new();
        for host in &candidates {
            let (host, user, pass) = (host.clone(), email.to_string(), password.to_string());
            let found = tokio::task::spawn_blocking(move || carddav::discover_carddav_blocking(host, user, pass)).await;
            if let Ok(Ok(books)) = found {
                if !books.is_empty() {
                    discovered = books;
                    break;
                }
            }
        }
        if discovered.is_empty() {
            notes.push("no CardDAV address book answered with these credentials".to_string());
        }
        for book in discovered {
            let (account, user, pass) = (email.to_string(), email.to_string(), password.to_string());
            let added = tokio::task::spawn_blocking(move || {
                carddav::add_carddav_source_blocking(account, book.url, user, pass, book.display_name)
            })
            .await;
            match added {
                Ok(Ok(_)) => books_added += 1,
                Ok(Err(e)) => notes.push(format!("a discovered address book could not be added: {e}")),
                Err(e) => notes.push(format!("a discovered address book could not be added: {e}")),
            }
        }
    }

    (calendars_added, books_added, notes)
}

/// Imports one parsed block: resolves servers (discovery for `Auto`
/// blocks), then hands off to the exact `add_account`/`add_pop3_account`
/// the onboarding form uses -- verification, keychain rollback, and
/// special-folder resolution all come along for free.
async fn import_one(spec: &ParsedAccount) -> AccountImportOutcome {
    let failed = |detail: String| AccountImportOutcome {
        email: spec.email.clone(),
        status: "failed".to_string(),
        detail: Some(detail),
        calendars_added: 0,
        address_books_added: 0,
    };

    let already_exists = cache::open()
        .and_then(|conn| cache::get_account(&conn, &spec.email))
        .ok()
        .flatten()
        .is_some();
    if already_exists {
        return AccountImportOutcome {
            email: spec.email.clone(),
            status: "skipped".to_string(),
            detail: Some("an account with this address is already configured".to_string()),
            calendars_added: 0,
            address_books_added: 0,
        };
    }

    let incoming_host: Option<String>;
    let add_result = match &spec.incoming {
        Incoming::Auto => match discovery::discover_server_config(spec.email.clone()).await {
            Ok(config) => {
                incoming_host = Some(config.imap.host.clone());
                account::add_account(
                    spec.email.clone(),
                    spec.password.clone(),
                    spec.display_name.clone(),
                    config.imap.host,
                    config.imap.port,
                    false,
                    config.smtp.host,
                    config.smtp.port,
                    config.smtp_use_starttls,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .map(|_| ())
            }
            Err(e) => return failed(e),
        },
        Incoming::Imap { host, port, starttls } => {
            incoming_host = Some(host.clone());
            let smtp = spec.smtp.as_ref().expect("parser guarantees smtp for explicit hosts");
            account::add_account(
                spec.email.clone(),
                spec.password.clone(),
                spec.display_name.clone(),
                host.clone(),
                *port,
                *starttls,
                smtp.host.clone(),
                smtp.port,
                smtp.starttls,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .map(|_| ())
        }
        Incoming::Pop3 { host, port } => {
            incoming_host = Some(host.clone());
            let smtp = spec.smtp.as_ref().expect("parser guarantees smtp for explicit hosts");
            account::add_pop3_account(
                spec.email.clone(),
                spec.password.clone(),
                spec.display_name.clone(),
                host.clone(),
                *port,
                smtp.host.clone(),
                smtp.port,
                smtp.starttls,
            )
            .await
            .map(|_| ())
        }
    };

    if let Err(e) = add_result {
        return failed(e);
    }

    let (calendars_added, address_books_added, notes) = add_dav_services(
        &spec.email,
        &spec.password,
        incoming_host.as_deref(),
        spec.caldav,
        spec.carddav,
    )
    .await;

    AccountImportOutcome {
        email: spec.email.clone(),
        status: "added".to_string(),
        detail: if notes.is_empty() { None } else { Some(notes.join("; ")) },
        calendars_added,
        address_books_added,
    }
}

/// Imports every account described in the file at `path`, then deletes
/// the file (it contains passwords). Accounts import independently: one
/// bad password fails that account's row in the report, not the run. The
/// command itself only errors when the file can't be read or doesn't
/// parse -- in which case nothing was imported and the file is left in
/// place for the user to fix.
#[tauri::command]
pub async fn import_accounts_file(path: String) -> Result<ImportAccountsReport, String> {
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("could not open {path}: {e}"))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "{path} is {size} bytes -- too large to be an account import file (is this the right file?)"
        ));
    }

    let mut contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    let parse_result = parse_accounts(&contents);
    contents.zeroize();

    let accounts = parse_result.map_err(|e| {
        format!("{e} -- nothing was imported and the file was left in place; note it still contains your passwords")
    })?;
    if accounts.is_empty() {
        return Err(format!(
            "{path} contains no account blocks -- nothing was imported and the file was left in place"
        ));
    }

    let mut results = Vec::with_capacity(accounts.len());
    for spec in &accounts {
        results.push(import_one(spec).await);
    }
    drop(accounts); // zeroizes every remaining password copy

    let (file_deleted, delete_error) = match delete_import_file(&path) {
        Ok(()) => (true, None),
        Err(e) => {
            log::warn!("{e}");
            (false, Some(e))
        }
    };

    Ok(ImportAccountsReport { results, file_deleted, delete_error })
}

/// One account picked from the Thunderbird-import checklist in the
/// onboarding UI, plus the password the user typed for it (Thunderbird's
/// own store is NSS-encrypted -- see `thunderbird_import.rs` -- so this is
/// the one field the scan can never supply). Radioactive like
/// `ParsedAccount`: zeroized on drop.
#[derive(Debug, serde::Deserialize)]
pub struct ThunderbirdImportSpec {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
    /// "imap" or "pop3", matching `thunderbird_import::DiscoveredAccount`.
    pub protocol: String,
    pub incoming_host: String,
    pub incoming_port: u16,
    pub incoming_starttls: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_starttls: bool,
}

impl Drop for ThunderbirdImportSpec {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// Imports one account the user selected from the Thunderbird-import
/// checklist. A thin adapter onto `import_one` -- server settings came
/// from the Thunderbird scan rather than a parsed file block, but from
/// here on it's the exact same verify/save/CalDAV/CardDAV path every
/// other onboarding route uses. Takes one account per call (rather than
/// the whole selected batch) so the frontend can run the import
/// sequentially and update one row's status as each call resolves,
/// instead of the caller staring at a spinner until all twenty finish.
#[tauri::command]
pub async fn import_thunderbird_account(spec: ThunderbirdImportSpec) -> AccountImportOutcome {
    let parsed = ParsedAccount {
        email: spec.email.clone(),
        password: spec.password.clone(),
        display_name: spec.display_name.clone(),
        incoming: if spec.protocol == "pop3" {
            Incoming::Pop3 { host: spec.incoming_host.clone(), port: spec.incoming_port }
        } else {
            Incoming::Imap {
                host: spec.incoming_host.clone(),
                port: spec.incoming_port,
                starttls: spec.incoming_starttls,
            }
        },
        smtp: Some(SmtpSettings {
            host: spec.smtp_host.clone(),
            port: spec.smtp_port,
            starttls: spec.smtp_starttls,
        }),
        // Always probed, matching the manual onboarding form's behavior:
        // it checks for CalDAV/CardDAV with the same credentials right
        // after the mail login verifies, without asking first.
        caldav: true,
        carddav: true,
    };
    import_one(&parsed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_fully_specified_imap_block() {
        let accounts = parse_accounts(
            "email_address: you@example.com\n\
             password: hunter2\n\
             display_name: Work\n\
             imap_host: mail.example.com\n\
             imap_port: 993\n\
             imap_starttls: off\n\
             smtp_host: mail.example.com\n\
             smtp_port: 465\n\
             smtp_starttls: off\n\
             caldav_state: on\n\
             carddav_state: on\n",
        )
        .expect("should parse");

        assert_eq!(accounts.len(), 1);
        let account = &accounts[0];
        assert_eq!(account.email, "you@example.com");
        assert_eq!(account.password, "hunter2");
        assert_eq!(account.display_name.as_deref(), Some("Work"));
        assert_eq!(
            account.incoming,
            Incoming::Imap { host: "mail.example.com".to_string(), port: 993, starttls: false }
        );
        let smtp = account.smtp.as_ref().expect("smtp settings");
        assert_eq!((smtp.host.as_str(), smtp.port, smtp.starttls), ("mail.example.com", 465, false));
        assert!(account.caldav);
        assert!(account.carddav);
    }

    #[test]
    fn a_minimal_block_means_auto_discovery() {
        let accounts = parse_accounts("email: you@gmail.com\npassword: app-password\n").expect("should parse");
        assert_eq!(accounts[0].incoming, Incoming::Auto);
        assert!(accounts[0].smtp.is_none());
        assert!(!accounts[0].caldav);
        assert!(!accounts[0].carddav);
    }

    #[test]
    fn splits_blocks_on_blank_lines_and_dividers_and_skips_comments() {
        let accounts = parse_accounts(
            "# provisioning list\n\
             email_address: a@example.com\n\
             password: pw-a\n\
             \n\
             ; second one\n\
             email_address: b@example.com\n\
             password: pw-b\n\
             ---\n\
             email_address: c@example.com\n\
             password: pw-c\n",
        )
        .expect("should parse");
        let emails: Vec<&str> = accounts.iter().map(|a| a.email.as_str()).collect();
        assert_eq!(emails, ["a@example.com", "b@example.com", "c@example.com"]);
    }

    #[test]
    fn accepts_crlf_equals_signs_and_the_email_adress_spelling() {
        let accounts = parse_accounts(
            "email_adress = you@example.com\r\npassword = hunter2\r\n",
        )
        .expect("should parse");
        assert_eq!(accounts[0].email, "you@example.com");
        assert_eq!(accounts[0].password, "hunter2");
    }

    #[test]
    fn starttls_shifts_the_default_ports() {
        let accounts = parse_accounts(
            "email: you@example.com\n\
             password: pw\n\
             imap_host: mail.example.com\n\
             imap_starttls: on\n\
             smtp_host: mail.example.com\n\
             smtp_starttls: on\n",
        )
        .expect("should parse");
        assert_eq!(
            accounts[0].incoming,
            Incoming::Imap { host: "mail.example.com".to_string(), port: 143, starttls: true }
        );
        assert_eq!(accounts[0].smtp.as_ref().unwrap().port, 587);
    }

    #[test]
    fn pop3_blocks_default_to_port_995() {
        let accounts = parse_accounts(
            "email: you@example.net\n\
             password: pw\n\
             pop3_host: pop.example.net\n\
             smtp_host: smtp.example.net\n",
        )
        .expect("should parse");
        assert_eq!(
            accounts[0].incoming,
            Incoming::Pop3 { host: "pop.example.net".to_string(), port: 995 }
        );
        assert_eq!(accounts[0].smtp.as_ref().unwrap().port, 465);
    }

    #[test]
    fn rejects_unknown_keys_with_the_line_number() {
        let err = parse_accounts("email: a@b.c\npasword: oops\n").expect_err("typoed key");
        assert!(err.contains("line 2"), "got: {err}");
        assert!(err.contains("pasword"), "got: {err}");
    }

    #[test]
    fn rejects_a_block_without_a_password() {
        let err = parse_accounts("email: a@example.com\n").expect_err("no password");
        assert!(err.contains("password is missing"), "got: {err}");
    }

    #[test]
    fn rejects_both_imap_and_pop3_hosts_in_one_block() {
        let err = parse_accounts(
            "email: a@example.com\npassword: pw\nimap_host: i\npop3_host: p\nsmtp_host: s\n",
        )
        .expect_err("conflicting protocols");
        assert!(err.contains("both imap_host and pop3_host"), "got: {err}");
    }

    #[test]
    fn rejects_half_specified_server_settings() {
        let err = parse_accounts("email: a@example.com\npassword: pw\nimap_host: mail.example.com\n")
            .expect_err("imap without smtp");
        assert!(err.contains("smtp_host is not"), "got: {err}");

        let err = parse_accounts("email: a@example.com\npassword: pw\nsmtp_host: smtp.example.com\n")
            .expect_err("smtp without incoming");
        assert!(err.contains("no imap_host or pop3_host"), "got: {err}");

        let err = parse_accounts("email: a@example.com\npassword: pw\nimap_port: 993\n")
            .expect_err("port without host");
        assert!(err.contains("'imap_host' is not"), "got: {err}");
    }

    #[test]
    fn rejects_duplicate_keys_bad_ports_bad_flags_and_valueless_lines() {
        let err = parse_accounts("email: a@example.com\nemail: b@example.com\npassword: pw\n")
            .expect_err("duplicate key");
        assert!(err.contains("set twice"), "got: {err}");

        let err = parse_accounts(
            "email: a@example.com\npassword: pw\nimap_host: h\nimap_port: banana\nsmtp_host: s\n",
        )
        .expect_err("bad port");
        assert!(err.contains("port number"), "got: {err}");

        let err = parse_accounts("email: a@example.com\npassword: pw\ncaldav_state: maybe\n")
            .expect_err("bad flag");
        assert!(err.contains("on or off"), "got: {err}");

        let err = parse_accounts("email: a@example.com\npassword:\n").expect_err("empty value");
        assert!(err.contains("has no value"), "got: {err}");

        let err = parse_accounts("email a@example.com\n").expect_err("no separator");
        assert!(err.contains("expected 'key: value'"), "got: {err}");
    }

    #[test]
    fn rejects_the_same_address_in_two_blocks() {
        let err = parse_accounts(
            "email: a@example.com\npassword: one\n\nemail: A@example.com\npassword: two\n",
        )
        .expect_err("duplicate address");
        assert!(err.contains("more than one account block"), "got: {err}");
    }

    #[test]
    fn rejects_addresses_that_are_not_addresses() {
        let err = parse_accounts("email: not-an-address\npassword: pw\n").expect_err("bad email");
        assert!(err.contains("doesn't look like an email address"), "got: {err}");
    }

    /// Full command path against a server that immediately refuses the
    /// connection: the account row must come back "failed" (with the
    /// credential rolled back by add_account), and the file -- passwords
    /// and all -- must still be deleted, because the import ran.
    #[tokio::test]
    #[ignore = "needs an OS keychain (stores and rolls back a test-only credential) and the local cache"]
    async fn import_reports_per_account_failure_and_still_deletes_the_file() {
        let path = std::env::temp_dir().join(format!(
            "helix-import-e2e-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Port 1 on localhost: nothing listens there, so the IMAP verify
        // fails fast with a connection error, no real server involved.
        std::fs::write(
            &path,
            "email: helix-import-test@example.invalid\n\
             password: not-a-real-password\n\
             imap_host: 127.0.0.1\n\
             imap_port: 1\n\
             smtp_host: 127.0.0.1\n",
        )
        .unwrap();

        let report = import_accounts_file(path.to_str().unwrap().to_string())
            .await
            .expect("per-account failures must not fail the command");

        assert_eq!(report.results.len(), 1);
        assert_eq!(report.results[0].status, "failed");
        assert!(report.results[0].detail.is_some());
        assert!(report.file_deleted, "the file must be deleted even when accounts fail");
        assert!(!path.exists());

        let leftover = crate::credentials::get_credential("helix-import-test@example.invalid".to_string());
        assert!(leftover.is_err(), "add_account should have rolled the credential back");
    }

    #[test]
    fn delete_import_file_overwrites_and_removes() {
        let path = std::env::temp_dir().join(format!(
            "helix-import-test-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "email: a@example.com\npassword: secret\n").unwrap();

        delete_import_file(path.to_str().unwrap()).expect("should delete");
        assert!(!path.exists(), "the import file must be gone after deletion");
    }
}
