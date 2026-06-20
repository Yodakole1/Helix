use std::borrow::Cow;

use async_imap::Session;
use futures::TryStreamExt;
use imap_proto::types::Address;
use mail_parser::MimeHeaders;
use serde::Serialize;
use tokio::net::TcpStream;
use tokio_native_tls::{TlsConnector, TlsStream};
use zeroize::Zeroize;

use crate::credentials;

type ImapSession = Session<TlsStream<TcpStream>>;

async fn connect_and_login(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> Result<ImapSession, String> {
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

    let client = async_imap::Client::new(tls_stream);
    client
        .login(email, password)
        .await
        .map_err(|(e, _client)| format!("login failed: {e}"))
}

/// Looks up the password for `account_id` in the OS keychain and uses it to
/// log in. `account_id` doubles as the IMAP login username — accounts are
/// identified by their email address, and that's what every mail server
/// here expects as the username too.
///
/// The password only ever exists as a plain `String` for the duration of
/// this call; it's wiped from memory immediately after, success or failure,
/// rather than just left for the allocator to reclaim whenever.
async fn login_with_stored_credential(
    host: &str,
    port: u16,
    account_id: &str,
) -> Result<ImapSession, String> {
    let mut password = credentials::get_credential(account_id.to_string())?;
    let result = connect_and_login(host, port, account_id, &password).await;
    password.zeroize();
    result
}

#[tauri::command]
pub async fn list_folders(
    account_id: String,
    host: String,
    port: u16,
) -> Result<Vec<String>, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;

    let folders: Vec<String> = session
        .list(None, Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {e}"))?
        .map_ok(|name| name.name().to_string())
        .try_collect()
        .await
        .map_err(|e| format!("LIST failed: {e}"))?;

    session.logout().await.ok();

    Ok(folders)
}

#[derive(Debug, Serialize)]
pub struct MessageSummary {
    pub uid: Option<u32>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub seen: bool,
    pub flagged: bool,
}

/// Plain UTF-8 decoding for header parts that are never RFC 2047 encoded —
/// the mailbox/host parts of an address are restricted to ASCII by the mail
/// protocols involved, so there's no encoded-word syntax to look for there.
fn decode_lossy(bytes: &Option<Cow<[u8]>>) -> Option<String> {
    bytes
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
}

/// Decodes header text that may contain RFC 2047 encoded words (e.g.
/// `=?UTF-8?B?...?=`), which is how non-ASCII subjects and display names
/// are represented in mail headers. Falls back to plain UTF-8 if a header
/// is malformed rather than dropping the field entirely.
fn decode_header_text(bytes: &Option<Cow<[u8]>>) -> Option<String> {
    bytes.as_ref().map(|b| {
        rfc2047_decoder::decode(b.as_ref()).unwrap_or_else(|_| String::from_utf8_lossy(b).into_owned())
    })
}

fn format_address(address: &Address) -> String {
    let mailbox = decode_lossy(&address.mailbox);
    let host = decode_lossy(&address.host);
    let email = match (mailbox, host) {
        (Some(mailbox), Some(host)) => format!("{mailbox}@{host}"),
        (Some(mailbox), None) => mailbox,
        _ => String::new(),
    };

    match decode_header_text(&address.name) {
        Some(name) if !name.is_empty() => format!("{name} <{email}>"),
        _ => email,
    }
}

/// Fetches the most recent `limit` messages in `folder`, newest last (the
/// order the server reports them in). Opens the folder read-only (EXAMINE)
/// since this is a preview-only operation — it shouldn't mark anything as
/// read or otherwise change mailbox state.
async fn fetch_recent_messages(
    session: &mut ImapSession,
    folder: &str,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let mailbox = session
        .examine(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    if mailbox.exists == 0 || limit == 0 {
        return Ok(Vec::new());
    }

    let first = mailbox.exists.saturating_sub(limit.saturating_sub(1)).max(1);
    let sequence_set = format!("{first}:{}", mailbox.exists);

    session
        .fetch(&sequence_set, "(UID FLAGS ENVELOPE INTERNALDATE)")
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .map_ok(|fetch| {
            let envelope = fetch.envelope();
            MessageSummary {
                uid: fetch.uid,
                subject: envelope.and_then(|e| decode_header_text(&e.subject)),
                from: envelope
                    .and_then(|e| e.from.as_ref())
                    .and_then(|addresses| addresses.first())
                    .map(format_address),
                date: fetch.internal_date().map(|d| d.to_rfc3339()),
                seen: fetch.flags().any(|flag| flag == async_imap::types::Flag::Seen),
                flagged: fetch.flags().any(|flag| flag == async_imap::types::Flag::Flagged),
            }
        })
        .try_collect()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))
}

#[tauri::command]
pub async fn fetch_messages(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = fetch_recent_messages(&mut session, &folder, limit).await;
    session.logout().await.ok();
    result
}

#[derive(Debug, Serialize)]
pub struct AttachmentInfo {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

#[derive(Debug, Serialize)]
pub struct MessageBody {
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
}

fn content_type_string(content_type: &mail_parser::ContentType) -> String {
    match &content_type.c_subtype {
        Some(subtype) => format!("{}/{}", content_type.c_type, subtype),
        None => content_type.c_type.to_string(),
    }
}

/// Fetches the full content of a single message by UID and parses it into
/// a plain text body, an HTML body (if present), and attachment metadata.
///
/// Opens the folder with `SELECT`, not `EXAMINE` — unlike `fetch_messages`,
/// this represents the user actually opening a message to read it, so
/// fetching `BODY[]` is expected to mark it `\Seen`, same as any other mail
/// client.
async fn fetch_body_by_uid(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<MessageBody, String> {
    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let raw_message: Vec<u8> = session
        .uid_fetch(uid.to_string(), "BODY[]")
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .try_next()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .and_then(|fetch| fetch.body().map(|b| b.to_vec()))
        .ok_or_else(|| format!("no message with UID {uid} in {folder}"))?;

    let message = mail_parser::MessageParser::default()
        .parse(&raw_message)
        .ok_or_else(|| "could not parse message content".to_string())?;

    let text = message.body_text(0).map(|s| s.into_owned());
    let html = message.body_html(0).map(|s| s.into_owned());
    let attachments = message
        .attachments()
        .map(|part| AttachmentInfo {
            filename: part.attachment_name().map(|s| s.to_string()),
            content_type: part.content_type().map(content_type_string),
            size: part.len(),
        })
        .collect();

    Ok(MessageBody {
        text,
        html,
        attachments,
    })
}

#[tauri::command]
pub async fn fetch_message_body(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
) -> Result<MessageBody, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = fetch_body_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();
    result
}

/// Adds or removes one flag on one message via `UID STORE`. Opens the
/// folder with `SELECT`, not `EXAMINE` -- unlike `fetch_messages`, this is
/// specifically here to mutate mailbox state.
async fn set_flag(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    flag: &str,
    set: bool,
) -> Result<(), String> {
    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let sign = if set { "+" } else { "-" };
    session
        .uid_store(uid.to_string(), format!("{sign}FLAGS.SILENT ({flag})"))
        .await
        .map_err(|e| format!("STORE failed: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("STORE failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn set_message_seen(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
    seen: bool,
) -> Result<(), String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, uid, "\\Seen", seen).await;
    session.logout().await.ok();
    result
}

#[tauri::command]
pub async fn set_message_flagged(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
    flagged: bool,
) -> Result<(), String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, uid, "\\Flagged", flagged).await;
    session.logout().await.ok();
    result
}

/// Fallback for servers that support neither MOVE (RFC 6851) nor UIDPLUS
/// (RFC 4315): COPY to the destination, mark the original `\Deleted`, then
/// `UID EXPUNGE` just that one UID without touching anything else flagged
/// `\Deleted` in the folder.
async fn move_via_copy_store_uid_expunge(
    session: &mut ImapSession,
    uid_str: &str,
    destination_folder: &str,
) -> Result<(), String> {
    session
        .uid_copy(uid_str, destination_folder)
        .await
        .map_err(|e| format!("COPY failed: {e}"))?;

    session
        .uid_store(uid_str, "+FLAGS.SILENT (\\Deleted)")
        .await
        .map_err(|e| format!("STORE failed: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("STORE failed: {e}"))?;

    session
        .uid_expunge(uid_str)
        .await
        .map_err(|e| format!("EXPUNGE failed: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("EXPUNGE failed: {e}"))?;

    Ok(())
}

/// Last-resort fallback for servers with neither MOVE nor UIDPLUS (the
/// real professional mail host used elsewhere in these docs for manual
/// verification is one -- see `mailbox-actions.md`). A bare `EXPUNGE`
/// would remove every `\Deleted` message in the folder, not just this
/// one, so any message some other client had already marked `\Deleted`
/// and not yet cleaned up would be silently destroyed too. Instead: find
/// those other already-deleted messages, temporarily un-delete them,
/// delete only the target UID, expunge, then restore their `\Deleted`
/// flag. This is the exact dance RFC 3501's own `STORE`/`EXPUNGE`
/// documentation describes for this situation -- not a novel workaround.
///
/// Not race-free: a message marked `\Deleted` by another client between
/// the `SEARCH` and the `EXPUNGE` here would still be removed. That
/// window is inherent to not having UIDPLUS, not a bug in this function.
async fn move_via_search_store_expunge(
    session: &mut ImapSession,
    uid: u32,
    destination_folder: &str,
) -> Result<(), String> {
    let uid_str = uid.to_string();

    session
        .uid_copy(&uid_str, destination_folder)
        .await
        .map_err(|e| format!("COPY failed: {e}"))?;

    let other_deleted: Vec<u32> = session
        .uid_search("DELETED")
        .await
        .map_err(|e| format!("SEARCH failed: {e}"))?
        .into_iter()
        .filter(|&other_uid| other_uid != uid)
        .collect();
    let other_deleted_set = other_deleted
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    if !other_deleted.is_empty() {
        session
            .uid_store(&other_deleted_set, "-FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| format!("STORE failed: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("STORE failed: {e}"))?;
    }

    let delete_and_expunge_result: Result<(), String> = async {
        session
            .uid_store(&uid_str, "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| format!("STORE failed: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("STORE failed: {e}"))?;

        session
            .expunge()
            .await
            .map_err(|e| format!("EXPUNGE failed: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("EXPUNGE failed: {e}"))?;

        Ok(())
    }
    .await;

    let restore_result = if other_deleted.is_empty() {
        Ok(())
    } else {
        session
            .uid_store(&other_deleted_set, "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|e| format!("restoring other \\Deleted flags failed: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("restoring other \\Deleted flags failed: {e}"))
            .map(|_: Vec<_>| ())
    };

    delete_and_expunge_result?;
    restore_result?;
    Ok(())
}

/// Moves one message by UID into `destination_folder`, preferring the
/// most reliable mechanism the server actually supports: MOVE (RFC 6851)
/// first, then a UIDPLUS-based COPY+STORE+EXPUNGE, then the careful
/// SEARCH-based dance as a last resort. See `mailbox-actions.md` for why
/// all three exist -- real providers in the wild are split across all
/// three capability levels.
async fn move_message(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    destination_folder: &str,
) -> Result<(), String> {
    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let capabilities = session
        .capabilities()
        .await
        .map_err(|e| format!("CAPABILITY failed: {e}"))?;
    let uid_str = uid.to_string();

    if capabilities.has_str("MOVE") {
        return session
            .uid_mv(&uid_str, destination_folder)
            .await
            .map_err(|e| format!("MOVE failed: {e}"));
    }

    if capabilities.has_str("UIDPLUS") {
        return move_via_copy_store_uid_expunge(session, &uid_str, destination_folder).await;
    }

    move_via_search_store_expunge(session, uid, destination_folder).await
}

#[tauri::command]
pub async fn move_message_to_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
    destination_folder: String,
) -> Result<(), String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = move_message(&mut session, &folder, uid, &destination_folder).await;
    session.logout().await.ok();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_header_text_handles_encoded_words() {
        // "Héllo, wörld!" in UTF-8, base64-encoded as an RFC 2047 word.
        let encoded = Cow::Borrowed("=?UTF-8?B?SMOpbGxvLCB3w7ZybGQh?=".as_bytes());
        assert_eq!(
            decode_header_text(&Some(encoded)).unwrap(),
            "Héllo, wörld!"
        );
    }

    #[test]
    fn decode_header_text_passes_through_plain_ascii() {
        let plain = Cow::Borrowed("just a normal subject".as_bytes());
        assert_eq!(
            decode_header_text(&Some(plain)).unwrap(),
            "just a normal subject"
        );
    }

    #[test]
    fn decode_header_text_falls_back_on_malformed_input() {
        let malformed = Cow::Borrowed("=?UTF-8?Q?not valid%%%?=".as_bytes());
        // Should not panic or return None -- worst case is the raw text.
        assert!(decode_header_text(&Some(malformed)).is_some());
    }

    #[test]
    fn format_address_decodes_an_encoded_display_name() {
        let address = Address {
            name: Some(Cow::Borrowed("=?UTF-8?B?SMOpbGxvbA==?=".as_bytes())),
            adl: None,
            mailbox: Some(Cow::Borrowed("hello".as_bytes())),
            host: Some(Cow::Borrowed("example.com".as_bytes())),
        };
        assert_eq!(format_address(&address), "Héllol <hello@example.com>");
    }

    // Hits a real external IMAP server, so it's excluded from the default
    // test run. There are no real credentials to test a full login with;
    // this checks that the TCP connect, TLS handshake, and IMAP command
    // framing all work by confirming we get an IMAP-level login failure
    // rather than a network or TLS error. Also exercises the keychain
    // lookup path: the credential is stored for real before the call and
    // removed afterward, same as account onboarding would do.
    #[tokio::test]
    #[ignore = "requires network access to a real IMAP server"]
    async fn connects_and_handshakes_with_a_real_imap_server() {
        let account_id = "helix-test-no-such-account@gmail.com";
        credentials::store_credential(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
        )
        .expect("storing the test credential should succeed");

        let result = list_folders(account_id.to_string(), "imap.gmail.com".to_string(), 993).await;

        credentials::delete_credential(account_id.to_string()).ok();

        let err = result.expect_err("login should fail without real credentials");
        assert!(
            err.starts_with("login failed"),
            "expected an IMAP login failure, got: {err}"
        );
    }

    #[tokio::test]
    #[ignore = "requires network access to a real IMAP server"]
    async fn fetch_messages_also_fails_at_the_login_step_without_real_credentials() {
        let account_id = "helix-test-no-such-account@gmail.com";
        credentials::store_credential(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
        )
        .expect("storing the test credential should succeed");

        let result = fetch_messages(
            account_id.to_string(),
            "imap.gmail.com".to_string(),
            993,
            "INBOX".to_string(),
            10,
        )
        .await;

        credentials::delete_credential(account_id.to_string()).ok();

        let err = result.expect_err("login should fail without real credentials");
        assert!(
            err.starts_with("login failed"),
            "expected an IMAP login failure, got: {err}"
        );
    }

    /// Shared GreenMail connection setup for the local-test-server suite
    /// below. GreenMail's TLS cert is self-signed, so this builds its own
    /// permissive connector instead of going through `connect_and_login` —
    /// production code must keep validating certificates normally.
    async fn connect_to_greenmail_and_login() -> ImapSession {
        let tcp_stream = TcpStream::connect(("127.0.0.1", 3993))
            .await
            .expect("GreenMail should be reachable on 127.0.0.1:3993");

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

        async_imap::Client::new(tls_stream)
            .login("helix", "helixpass")
            .await
            .map_err(|(e, _)| e)
            .expect("login to the GreenMail test account should succeed")
    }

    // Exercises the actual EXAMINE/FETCH/envelope-decoding logic against a
    // real IMAP server, which the two tests above never reach (they fail at
    // login). Needs a local GreenMail test server — see
    // docs/technical/imap-core.md for the docker command to start one and
    // inject a test message before running this.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/imap-core.md"]
    async fn parses_a_real_message_from_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        let messages = fetch_recent_messages(&mut session, "INBOX", 10)
            .await
            .expect("fetch should succeed");

        session.logout().await.ok();

        assert_eq!(messages.len(), 1, "expected exactly the one seeded message");
        let message = &messages[0];
        assert_eq!(message.uid, Some(1));
        assert_eq!(message.subject.as_deref(), Some("Helix test message"));
        assert_eq!(message.from.as_deref(), Some("Sender Name <sender@helix.test>"));
        assert!(!message.seen, "EXAMINE must not mark the message as seen");
        assert!(message.date.is_some());
    }

    // Exercises fetch_body_by_uid's SELECT/FETCH/MIME-parsing pipeline
    // against a real multipart message (plain text + HTML + a PDF
    // attachment). Needs a fresh local GreenMail container with exactly
    // that one multipart message seeded as UID 1 — see
    // docs/technical/imap-core.md for the exact send script.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/imap-core.md"]
    async fn parses_a_multipart_message_with_attachment_from_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        let body = fetch_body_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");

        session.logout().await.ok();

        assert_eq!(body.text.as_deref(), Some("This is the plain text body."));
        assert!(body.html.unwrap().contains("<b>HTML</b>"));
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].filename.as_deref(), Some("document.pdf"));
        assert_eq!(body.attachments[0].content_type.as_deref(), Some("application/pdf"));
        assert!(body.attachments[0].size > 0);
    }

    // Exercises set_flag's UID STORE path for \Seen against a real message.
    // Needs the same single-message GreenMail seed as
    // parses_a_real_message_from_a_local_test_server — see
    // docs/technical/mailbox-actions.md.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/mailbox-actions.md"]
    async fn sets_and_clears_the_seen_flag_against_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        set_flag(&mut session, "INBOX", 1, "\\Seen", true)
            .await
            .expect("setting \\Seen should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(messages[0].seen, "message should be seen after setting the flag");

        set_flag(&mut session, "INBOX", 1, "\\Seen", false)
            .await
            .expect("clearing \\Seen should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(!messages[0].seen, "message should not be seen after clearing the flag");

        session.logout().await.ok();
    }

    // Same shape as the \Seen test above, for \Flagged -- the "star" action.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/mailbox-actions.md"]
    async fn sets_and_clears_the_flagged_flag_against_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;

        set_flag(&mut session, "INBOX", 1, "\\Flagged", true)
            .await
            .expect("setting \\Flagged should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(messages[0].flagged, "message should be flagged after setting the flag");

        set_flag(&mut session, "INBOX", 1, "\\Flagged", false)
            .await
            .expect("clearing \\Flagged should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(!messages[0].flagged, "message should not be flagged after clearing the flag");

        session.logout().await.ok();
    }

    // Exercises move_message's dispatcher end to end: GreenMail advertises
    // the MOVE capability, so this is also proof that the capability check
    // correctly prefers MOVE when it's available, not just that uid_mv
    // works in isolation.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/mailbox-actions.md"]
    async fn moves_a_message_via_the_move_extension_on_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;
        session
            .create("Archive")
            .await
            .expect("creating the destination folder should succeed");

        move_message(&mut session, "INBOX", 1, "Archive")
            .await
            .expect("move should succeed");

        let inbox_messages = fetch_recent_messages(&mut session, "INBOX", 10)
            .await
            .expect("fetch should succeed");
        assert!(inbox_messages.is_empty(), "the message should no longer be in INBOX");

        let archive_messages = fetch_recent_messages(&mut session, "Archive", 10)
            .await
            .expect("fetch should succeed");
        assert_eq!(archive_messages.len(), 1, "the message should have landed in Archive");

        session.logout().await.ok();
    }

    // GreenMail itself always advertises MOVE, so the only way to exercise
    // the UIDPLUS-based fallback's actual mechanics is to call it directly
    // rather than through move_message's capability check.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/mailbox-actions.md"]
    async fn moves_a_message_via_the_uidplus_fallback_on_a_local_test_server() {
        let mut session = connect_to_greenmail_and_login().await;
        session
            .create("Archive")
            .await
            .expect("creating the destination folder should succeed");
        session.select("INBOX").await.expect("select should succeed");

        move_via_copy_store_uid_expunge(&mut session, "1", "Archive")
            .await
            .expect("move should succeed");

        let inbox_messages = fetch_recent_messages(&mut session, "INBOX", 10)
            .await
            .expect("fetch should succeed");
        assert!(inbox_messages.is_empty(), "the message should no longer be in INBOX");

        let archive_messages = fetch_recent_messages(&mut session, "Archive", 10)
            .await
            .expect("fetch should succeed");
        assert_eq!(archive_messages.len(), 1, "the message should have landed in Archive");

        session.logout().await.ok();
    }

    // The important case for the last-resort fallback: a second message
    // (UID 2) stands in for one some *other* IMAP client already marked
    // \Deleted and hasn't expunged yet -- exactly what this fallback exists
    // to not destroy while moving UID 1. Needs a GreenMail container seeded
    // with two plain-text messages (UIDs 1 and 2) -- see
    // docs/technical/mailbox-actions.md.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/mailbox-actions.md"]
    async fn moves_a_message_via_the_search_fallback_without_losing_other_deleted_messages_on_a_local_test_server()
     {
        let mut session = connect_to_greenmail_and_login().await;
        session
            .create("Archive")
            .await
            .expect("creating the destination folder should succeed");
        session.select("INBOX").await.expect("select should succeed");

        session
            .uid_store("2", "+FLAGS.SILENT (\\Deleted)")
            .await
            .expect("marking UID 2 deleted should succeed")
            .try_collect::<Vec<_>>()
            .await
            .expect("marking UID 2 deleted should succeed");

        move_via_search_store_expunge(&mut session, 1, "Archive")
            .await
            .expect("move should succeed");

        let inbox_messages = fetch_recent_messages(&mut session, "INBOX", 10)
            .await
            .expect("fetch should succeed");
        assert_eq!(
            inbox_messages.len(),
            1,
            "UID 2 must survive the expunge -- only UID 1 should have been removed"
        );
        assert_eq!(inbox_messages[0].uid, Some(2));

        let still_deleted = session
            .uid_search("DELETED")
            .await
            .expect("search should succeed");
        assert!(
            still_deleted.contains(&2),
            "UID 2's \\Deleted flag should have been restored after the expunge"
        );

        let archive_messages = fetch_recent_messages(&mut session, "Archive", 10)
            .await
            .expect("fetch should succeed");
        assert_eq!(archive_messages.len(), 1, "UID 1 should have landed in Archive");

        session.logout().await.ok();
    }
}
