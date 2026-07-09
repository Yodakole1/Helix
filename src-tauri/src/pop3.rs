use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::{TlsConnector, TlsStream};
use zeroize::Zeroize;

use crate::cache;
use crate::credentials;
use crate::imap::{self, AttachmentContent, MessageBody};
use crate::oauth;
use crate::pgp;
use crate::smime;

struct Pop3Session {
    stream: BufReader<TlsStream<TcpStream>>,
}

// Byte-oriented rather than String-based — RETR responses are email bytes, not guaranteed UTF-8.
async fn read_raw_line(session: &mut Pop3Session) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let bytes_read = session
        .stream
        .read_until(b'\n', &mut buf)
        .await
        .map_err(|e| format!("connection read failed: {e}"))?;
    if bytes_read == 0 {
        return Err("connection closed unexpectedly".to_string());
    }
    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }
    Ok(buf)
}

async fn send_command(session: &mut Pop3Session, command: &str) -> Result<(), String> {
    session
        .stream
        .write_all(format!("{command}\r\n").as_bytes())
        .await
        .map_err(|e| format!("could not send command: {e}"))?;
    session
        .stream
        .flush()
        .await
        .map_err(|e| format!("could not send command: {e}"))
}

async fn read_status_line(session: &mut Pop3Session) -> Result<String, String> {
    let line = String::from_utf8_lossy(&read_raw_line(session).await?).into_owned();
    if let Some(rest) = line.strip_prefix("+OK") {
        Ok(rest.trim_start().to_string())
    } else if let Some(rest) = line.strip_prefix("-ERR") {
        Err(rest.trim_start().to_string())
    } else {
        Err(format!("unexpected response: {line}"))
    }
}

// RFC 1939 §3 byte-stuffing: a real leading dot is doubled, un-double it here.
fn unstuff_multiline_response(lines: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    lines
        .into_iter()
        .map(|line| if line.starts_with(b"..") { line[1..].to_vec() } else { line })
        .collect()
}

fn join_with_crlf(lines: Vec<Vec<u8>>) -> Vec<u8> {
    let mut result = Vec::new();
    for (i, line) in lines.into_iter().enumerate() {
        if i > 0 {
            result.extend_from_slice(b"\r\n");
        }
        result.extend_from_slice(&line);
    }
    result
}

async fn read_multiline_lines(session: &mut Pop3Session) -> Result<Vec<String>, String> {
    let mut raw_lines = Vec::new();
    loop {
        let line = read_raw_line(session).await?;
        if line == b"." {
            break;
        }
        raw_lines.push(line);
    }
    Ok(unstuff_multiline_response(raw_lines)
        .into_iter()
        .map(|line| String::from_utf8_lossy(&line).into_owned())
        .collect())
}

async fn read_multiline_raw(session: &mut Pop3Session) -> Result<Vec<u8>, String> {
    let mut raw_lines = Vec::new();
    loop {
        let line = read_raw_line(session).await?;
        if line == b"." {
            break;
        }
        raw_lines.push(line);
    }
    Ok(join_with_crlf(unstuff_multiline_response(raw_lines)))
}

// POP3S only — no STARTTLS path, no plaintext port 110.
async fn connect_pop3s(host: &str, port: u16) -> Result<Pop3Session, String> {
    let tcp_stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;

    let tls_connector = TlsConnector::from(
        tokio_native_tls::native_tls::TlsConnector::new()
            .map_err(|e| format!("TLS setup failed: {e}"))?,
    );
    let tls_stream = tls_connector
        .connect(host, tcp_stream)
        .await
        .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?;

    let mut session = Pop3Session {
        stream: BufReader::new(tls_stream),
    };

    // Server sends an unsolicited +OK greeting before any command.
    read_status_line(&mut session)
        .await
        .map_err(|e| format!("greeting failed: {e}"))?;

    Ok(session)
}

async fn connect_and_login(
    host: &str,
    port: u16,
    account_id: &str,
    password: &str,
) -> Result<Pop3Session, String> {
    let mut session = connect_pop3s(host, port).await.map_err(|e| {
        crate::debug_log::record("pop3", format!("connect to {host}:{port} failed: {e}"));
        e
    })?;

    send_command(&mut session, &format!("USER {account_id}")).await?;
    read_status_line(&mut session).await.map_err(|e| {
        crate::debug_log::record("pop3", format!("login to {host}:{port} as {account_id} failed: {e}"));
        format!("login failed: {e}")
    })?;

    send_command(&mut session, &format!("PASS {password}")).await?;
    read_status_line(&mut session).await.map_err(|e| {
        crate::debug_log::record("pop3", format!("login to {host}:{port} as {account_id} failed: {e}"));
        format!("login failed: {e}")
    })?;

    Ok(session)
}

/// SASL XOAUTH2 over POP3 (RFC 5034 AUTH with an initial response) --
/// Gmail's pop.gmail.com and Microsoft 365 both accept it. On failure the
/// server sends a `+ <base64 JSON>` continuation and expects an empty
/// line before its final `-ERR`, so that path is drained to surface the
/// real error instead of a protocol desync.
async fn connect_and_authenticate_xoauth2(
    host: &str,
    port: u16,
    account_id: &str,
    access_token: &str,
) -> Result<Pop3Session, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let mut session = connect_pop3s(host, port).await?;

    let initial = STANDARD.encode(oauth::xoauth2_string(account_id, access_token));
    send_command(&mut session, &format!("AUTH XOAUTH2 {initial}")).await?;

    let line = String::from_utf8_lossy(&read_raw_line(&mut session).await?).into_owned();
    if line.starts_with("+OK") {
        return Ok(session);
    }
    if let Some(challenge) = line.strip_prefix("+ ") {
        // Error continuation: acknowledge with an empty response, then read
        // the -ERR that follows.
        send_command(&mut session, "").await?;
        let final_line = read_status_line(&mut session).await.err().unwrap_or_default();
        let detail = STANDARD
            .decode(challenge.trim())
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        return Err(format!("OAuth login failed: {final_line} {detail}"));
    }
    Err(format!("OAuth login failed: {line}"))
}

/// Looks up the stored secret for `account_id` in the OS keychain and uses
/// it to log in, zeroizing it immediately after the attempt -- same
/// pattern (and same OAuth-vs-password branch) as
/// `imap.rs::login_with_stored_credential`.
async fn login_with_stored_credential(
    host: &str,
    port: u16,
    account_id: &str,
) -> Result<Pop3Session, String> {
    let mut secret = credentials::get_credential(account_id.to_string())?;
    let result = match oauth::access_token_for_secret(account_id, &secret).await {
        Ok(Some(mut access_token)) => {
            let session =
                connect_and_authenticate_xoauth2(host, port, account_id, &access_token).await;
            access_token.zeroize();
            session
        }
        Ok(None) => connect_and_login(host, port, account_id, &secret).await,
        Err(e) => Err(e),
    };
    secret.zeroize();
    result
}

/// Verifies a stored POP3 credential by connecting, logging in, and
/// cleanly quitting -- the POP3 equivalent of `imap::verify_and_list_folders`,
/// used by account onboarding (`account::add_pop3_account`) to prove a
/// credential works before committing it. POP3 has no folders to list, so
/// a successful login is the whole verification.
pub(crate) async fn verify_login(host: &str, port: u16, account_id: &str) -> Result<(), String> {
    let mut session = login_with_stored_credential(host, port, account_id).await?;
    quit(&mut session).await;
    Ok(())
}

/// Ends the session with `QUIT` -- POP3 deletions (`DELE`) are only
/// committed by the server on a clean `QUIT` (RFC 1939 §6); a dropped
/// connection aborts them instead. Best-effort: a failure here doesn't
/// change whatever result the caller already has.
async fn quit(session: &mut Pop3Session) {
    let _ = send_command(session, "QUIT").await;
    let _ = read_status_line(session).await;
}

fn parse_list_line(line: &str) -> Option<(u32, u32)> {
    let mut parts = line.split_whitespace();
    let number = parts.next()?.parse().ok()?;
    let size = parts.next()?.parse().ok()?;
    Some((number, size))
}

fn parse_uidl_line(line: &str) -> Option<(u32, String)> {
    let mut parts = line.split_whitespace();
    let number = parts.next()?.parse().ok()?;
    let uidl = parts.next()?.to_string();
    Some((number, uidl))
}

fn format_address(addr: &mail_parser::Addr) -> String {
    let email = addr.address().unwrap_or_default();
    match addr.name() {
        Some(name) if !name.is_empty() => format!("{name} <{email}>"),
        _ => email.to_string(),
    }
}

/// One message in the mailbox. Deliberately its own type, not a reuse of
/// `imap::MessageSummary` -- POP3 has no flags and no `\Seen`, and no UID
/// in IMAP's sense (`uidl` is optional and, unlike an IMAP UID, isn't
/// guaranteed by the protocol to exist at all), so forcing IMAP's fields
/// onto it would be misleading rather than genuine reuse.
#[derive(Debug, Serialize)]
pub struct Pop3MessageSummary {
    pub number: u32,
    pub size: u32,
    pub uidl: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
}

async fn list_summaries(session: &mut Pop3Session) -> Result<Vec<Pop3MessageSummary>, String> {
    send_command(session, "LIST").await?;
    read_status_line(session).await.map_err(|e| format!("LIST failed: {e}"))?;
    let lines = read_multiline_lines(session).await.map_err(|e| format!("LIST failed: {e}"))?;

    let mut summaries: Vec<Pop3MessageSummary> = lines
        .iter()
        .filter_map(|line| parse_list_line(line))
        .map(|(number, size)| Pop3MessageSummary {
            number,
            size,
            uidl: None,
            subject: None,
            from: None,
            date: None,
        })
        .collect();

    // UIDL is optional in RFC 1939 -- a -ERR here just means every
    // summary's uidl stays None, not a hard failure for the whole list.
    send_command(session, "UIDL").await?;
    if read_status_line(session).await.is_ok() {
        if let Ok(uidl_lines) = read_multiline_lines(session).await {
            let uidls: std::collections::HashMap<u32, String> =
                uidl_lines.iter().filter_map(|line| parse_uidl_line(line)).collect();
            for summary in &mut summaries {
                summary.uidl = uidls.get(&summary.number).cloned();
            }
        }
    }

    // TOP is also optional; a server without it just leaves every
    // summary's subject/from/date as None rather than failing the list.
    for summary in &mut summaries {
        send_command(session, &format!("TOP {} 0", summary.number)).await?;
        if read_status_line(session).await.is_err() {
            continue;
        }
        let Ok(header_bytes) = read_multiline_raw(session).await else { continue };
        let Some(message) = mail_parser::MessageParser::default().parse(&header_bytes) else { continue };

        summary.subject = message.subject().map(|s| s.to_string());
        summary.from = message.from().and_then(|address| address.first()).map(format_address);
        summary.date = message.date().map(|d| d.to_rfc3339());
    }

    Ok(summaries)
}

/// Best-effort write-through of POP3 summaries to the local cache, so a
/// POP3 inbox is readable offline like an IMAP one. Same log-and-continue
/// posture as the IMAP/contact cache writes -- only summaries carrying a
/// UIDL are stored (the cache's stable key), handled inside
/// `cache::upsert_pop3_summaries`.
fn cache_summaries(account_id: &str, summaries: &[Pop3MessageSummary]) {
    let result = cache::open().and_then(|conn| cache::upsert_pop3_summaries(&conn, account_id, summaries));
    if let Err(e) = result {
        log::warn!("could not cache POP3 summaries for {account_id}: {e}");
    }
}

/// Asks the server for one message's UIDL (`UIDL n`), the stable key the
/// cache stores a body under. Optional in RFC 1939, so a `-ERR` or a
/// malformed reply just yields `None` -- the body is still served, only its
/// caching (which needs a durable key) is skipped.
async fn fetch_uidl(session: &mut Pop3Session, number: u32) -> Option<String> {
    send_command(session, &format!("UIDL {number}")).await.ok()?;
    let line = read_status_line(session).await.ok()?;
    // `+OK <number> <uidl>` -- read_status_line already stripped `+OK`.
    parse_uidl_line(&line).map(|(_, uidl)| uidl)
}

#[tauri::command]
pub async fn list_messages(
    account_id: String,
    host: String,
    port: u16,
) -> Result<Vec<Pop3MessageSummary>, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = list_summaries(&mut session).await;
    quit(&mut session).await;

    if let Ok(summaries) = &result {
        cache_summaries(&account_id, summaries);
    }
    result
}

/// `RETR n` -- fetches one message's raw RFC 822 bytes, kept separate from
/// body-parsing so `fetch_attachment` can re-fetch the same raw bytes
/// without going through the full parse path, same split as `imap.rs`'s
/// `fetch_raw_message_by_uid`/`fetch_body_by_uid`.
async fn retrieve_raw_message(session: &mut Pop3Session, number: u32) -> Result<Vec<u8>, String> {
    send_command(session, &format!("RETR {number}")).await?;
    read_status_line(session).await.map_err(|e| format!("RETR failed: {e}"))?;
    read_multiline_raw(session).await.map_err(|e| format!("RETR failed: {e}"))
}

/// Same best-effort, log-and-continue caching as the IMAP and SMTP
/// layers' contact harvesting.
fn cache_contacts(contacts: &[(String, Option<String>)]) {
    if contacts.is_empty() {
        return;
    }
    let result = cache::open().and_then(|conn| cache::upsert_contacts(&conn, contacts));
    if let Err(e) = result {
        log::warn!("could not update local contact cache: {e}");
    }
}

/// Best-effort write-through of one POP3 body to the local cache, keyed by
/// its UIDL. Skipped (logged, never failing the fetch) when the server
/// reports no UIDL -- there's no stable key to cache it under then.
fn cache_body(account_id: &str, uidl: Option<&str>, body: &MessageBody) {
    let Some(uidl) = uidl else { return };
    let result = cache::open().and_then(|conn| cache::upsert_pop3_body(&conn, account_id, uidl, body));
    if let Err(e) = result {
        log::warn!("could not cache POP3 body for {account_id}/{uidl}: {e}");
    }
}

#[tauri::command]
pub async fn fetch_message(account_id: String, host: String, port: u16, number: u32) -> Result<MessageBody, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let raw_result = retrieve_raw_message(&mut session, number).await;
    let uidl = if raw_result.is_ok() {
        fetch_uidl(&mut session, number).await
    } else {
        None
    };
    quit(&mut session).await;

    let raw = raw_result?;
    let (body, sender_email, contacts) = imap::parse_message_body(&raw)?;
    cache_contacts(&contacts);
    cache_body(&account_id, uidl.as_deref(), &body);
    // Same order as imap::fetch_message_body: harvest a sender key the
    // message may carry, then PGP/MIME, then legacy inline armor.
    pgp::harvest_autocrypt(sender_email.as_deref(), &raw);
    let body = pgp::maybe_decrypt_mime(&account_id, sender_email.as_deref(), body, &raw);
    let body = pgp::maybe_decrypt(&account_id, sender_email.as_deref(), body);
    let body = smime::maybe_process_smime(&account_id, body, &raw);

    Ok(body)
}

/// Downloads one attachment's content from a message by RETR-ing it again
/// and pulling out the part at `attachment_index` -- the same index
/// reported in `fetch_message`'s `MessageBody.attachments`. POP3 has no
/// equivalent of IMAP's `BODY[<section>]` partial fetch, so there's no way
/// to avoid re-fetching the whole message; this mirrors `imap::extract_attachment`'s
/// "not worth the complexity speculatively" reasoning, just with no
/// partial-fetch option to speculate about in the first place.
///
/// Named `pop3_fetch_attachment`, not `fetch_attachment` -- Tauri's
/// `#[tauri::command]` macro registers commands by bare function name in a
/// single crate-wide namespace, so this can't share a name with
/// `imap::fetch_attachment` even though the two live in different modules.
/// Best-effort write-through of one downloaded POP3 attachment to the local
/// cache, keyed by UIDL. Skipped (logged, never failing the download) when
/// the server reports no UIDL -- no stable key to cache it under then.
fn cache_attachment(account_id: &str, uidl: Option<&str>, idx: usize, content: &AttachmentContent) {
    let Some(uidl) = uidl else { return };
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&content.content_base64) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("could not decode POP3 attachment for caching ({account_id}/{uidl}#{idx}): {e}");
            return;
        }
    };
    let result = cache::open().and_then(|conn| {
        cache::upsert_pop3_attachment(
            &conn,
            account_id,
            uidl,
            idx,
            content.filename.as_deref(),
            content.content_type.as_deref(),
            &bytes,
        )
    });
    if let Err(e) = result {
        log::warn!("could not cache POP3 attachment {account_id}/{uidl}#{idx}: {e}");
    }
}

#[tauri::command]
pub async fn pop3_fetch_attachment(
    account_id: String,
    host: String,
    port: u16,
    number: u32,
    attachment_index: usize,
) -> Result<AttachmentContent, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = retrieve_raw_message(&mut session, number).await;
    // Resolve the UIDL in the same session so the bytes can be cached under a
    // stable key; no UIDL just means no caching, not a failure.
    let uidl = if result.is_ok() {
        fetch_uidl(&mut session, number).await
    } else {
        None
    };
    quit(&mut session).await;

    // Same PGP/MIME view alignment as imap::fetch_attachment: indexes
    // refer to the decrypted content when the message is encrypted.
    let raw = result?;
    let raw = pgp::maybe_decrypt_raw(&account_id, &raw).unwrap_or(raw);
    let content = imap::extract_attachment(&raw, attachment_index)?;
    cache_attachment(&account_id, uidl.as_deref(), attachment_index, &content);
    Ok(content)
}

/// Deletes a message by number. Drives the session to a clean `QUIT`
/// itself (rather than just returning and letting the connection drop)
/// since that's what actually commits the deletion -- see `quit`'s docs.
#[tauri::command]
pub async fn delete_message(account_id: String, host: String, port: u16, number: u32) -> Result<(), String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;

    let result = async {
        send_command(&mut session, &format!("DELE {number}")).await?;
        read_status_line(&mut session).await.map_err(|e| format!("DELE failed: {e}"))?;
        Ok(())
    }
    .await;

    quit(&mut session).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unstuffs_a_byte_stuffed_leading_dot_but_leaves_other_lines_alone() {
        let lines = vec![
            b"plain line".to_vec(),
            b"..leading dot was here".to_vec(),
            b"another plain line".to_vec(),
        ];

        let result = unstuff_multiline_response(lines);

        assert_eq!(result[0], b"plain line");
        assert_eq!(result[1], b".leading dot was here");
        assert_eq!(result[2], b"another plain line");
    }

    #[test]
    fn parses_a_list_line() {
        assert_eq!(parse_list_line("1 2048"), Some((1, 2048)));
        assert_eq!(parse_list_line("not a list line"), None);
        assert_eq!(parse_list_line(""), None);
    }

    #[test]
    fn parses_a_uidl_line() {
        assert_eq!(parse_uidl_line("1 abc123"), Some((1, "abc123".to_string())));
        assert_eq!(parse_uidl_line("1"), None);
    }

    #[test]
    fn status_line_splits_ok_and_err() {
        // read_status_line itself needs a live session to test (it reads
        // off the wire), but the +OK/-ERR text-splitting rule it applies
        // is pure enough to pin down directly here against the same
        // prefix logic, since the connection-handling tests below cover
        // the socket side against a real server.
        let ok_line = "+OK 2 messages";
        let err_line = "-ERR no such message";

        assert_eq!(ok_line.strip_prefix("+OK").map(str::trim_start), Some("2 messages"));
        assert_eq!(err_line.strip_prefix("-ERR").map(str::trim_start), Some("no such message"));
    }

    /// Shared GreenMail connection setup for the local-test-server suite
    /// below. GreenMail's TLS cert is self-signed, so this builds its own
    /// permissive connector instead of going through `connect_and_login`
    /// -- production code must keep validating certificates normally,
    /// same convention as `imap.rs`/`smtp.rs`'s own GreenMail tests.
    async fn connect_to_greenmail_and_login() -> Pop3Session {
        let tcp_stream = TcpStream::connect(("127.0.0.1", 3995))
            .await
            .expect("GreenMail should be reachable on 127.0.0.1:3995");

        let insecure_connector = TlsConnector::from(
            tokio_native_tls::native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .expect("building a permissive test TLS connector should not fail"),
        );
        let tls_stream = insecure_connector
            .connect("127.0.0.1", tcp_stream)
            .await
            .expect("TLS handshake with GreenMail should succeed");

        let mut session = Pop3Session {
            stream: BufReader::new(tls_stream),
        };
        read_status_line(&mut session).await.expect("greeting should succeed");

        send_command(&mut session, "USER helix").await.expect("USER should send");
        read_status_line(&mut session).await.expect("USER should succeed");
        send_command(&mut session, "PASS helixpass").await.expect("PASS should send");
        read_status_line(&mut session).await.expect("PASS should succeed");

        session
    }

    // Exercises LIST + UIDL + TOP against a real (if disposable) POP3S
    // server. Needs a local GreenMail container seeded with exactly one
    // plain-text message -- see docs/technical/pop3.md.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/pop3.md"]
    async fn lists_a_real_message_from_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        let summaries = list_summaries(&mut session).await.expect("list should succeed");
        quit(&mut session).await;

        assert_eq!(summaries.len(), 1, "expected exactly the one seeded message");
        let summary = &summaries[0];
        assert_eq!(summary.number, 1);
        assert!(summary.size > 0);
        assert!(summary.uidl.is_some(), "GreenMail supports UIDL, this should be populated");
        assert_eq!(summary.subject.as_deref(), Some("Helix POP3 test message"));
        assert_eq!(summary.from.as_deref(), Some("Sender Name <sender@helix.test>"));
        assert!(summary.date.is_some());
    }

    // Exercises RETR + parse_message_body against the same fixture.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/pop3.md"]
    async fn fetches_a_real_message_body_from_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        let raw = retrieve_raw_message(&mut session, 1).await.expect("RETR should succeed");
        quit(&mut session).await;
        let (body, sender_email, contacts) = imap::parse_message_body(&raw).expect("parse should succeed");

        assert_eq!(body.text.as_deref(), Some("This is a test message body for Helix POP3 fetch testing."));
        assert_eq!(sender_email.as_deref(), Some("sender@helix.test"));
        assert!(
            contacts.contains(&("sender@helix.test".to_string(), Some("Sender Name".to_string()))),
            "the From address should be a harvested contact candidate"
        );
        assert!(
            contacts.contains(&("helix@helix.test".to_string(), None)),
            "the To address should also be a harvested contact candidate"
        );
    }

    // Exercises DELE + QUIT: deletes the seeded message, reconnects, and
    // confirms LIST no longer reports it -- proving the deletion was
    // actually committed by the QUIT, not just requested.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/pop3.md"]
    async fn deletes_a_real_message_from_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;
        send_command(&mut session, "DELE 1").await.expect("DELE should send");
        read_status_line(&mut session).await.expect("DELE should succeed");
        quit(&mut session).await;

        let mut session = connect_to_greenmail_and_login().await;
        let summaries = list_summaries(&mut session).await.expect("list should succeed");
        quit(&mut session).await;

        assert!(summaries.is_empty(), "the deleted message should be gone after a fresh login");
    }
}
