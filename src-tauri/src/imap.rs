use std::borrow::Cow;

use async_imap::Session;
use futures::TryStreamExt;
use imap_proto::types::Address;
use mail_parser::MimeHeaders;
use serde::Serialize;
use tokio::net::TcpStream;
use tokio_native_tls::{TlsConnector, TlsStream};
use zeroize::Zeroize;

use crate::cache;
use crate::credentials;
use crate::pgp;

pub(crate) type ImapSession = Session<TlsStream<TcpStream>>;

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
pub(crate) async fn login_with_stored_credential(
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
    /// This message's own `Message-ID`, stripped of angle brackets. Used
    /// by `group_into_threads` to identify conversation roots and by reply
    /// composition to set `In-Reply-To` on the outgoing message.
    pub message_id: Option<String>,
    /// The `In-Reply-To` value (angle brackets stripped), pointing at the
    /// parent message's `Message-ID`. `None` for original messages.
    /// Used by `group_into_threads` to link replies to their parents.
    pub in_reply_to: Option<String>,
}

/// One conversation thread: a root message and its nested reply chain.
/// Replies within a thread are themselves `ThreadedMessage`s so multi-level
/// conversations (A → B → C) are represented naturally as nested structs
/// rather than a flat list that the frontend would have to reconstruct.
#[derive(Debug, Serialize)]
pub struct ThreadedMessage {
    pub message: MessageSummary,
    pub replies: Vec<ThreadedMessage>,
}

/// IMAP ENVELOPE returns `Message-ID` and `In-Reply-To` as their raw header
/// values, angle brackets included (e.g. `<abc@example.com>`). Strips them
/// so callers get a bare ID string that compares equal to what `mail_parser`
/// returns from a parsed message body (which also strips them).
fn strip_angle_brackets(s: String) -> String {
    let t = s.trim();
    if t.starts_with('<') && t.ends_with('>') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
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
                message_id: envelope
                    .and_then(|e| decode_lossy(&e.message_id))
                    .map(strip_angle_brackets),
                in_reply_to: envelope
                    .and_then(|e| decode_lossy(&e.in_reply_to))
                    .map(strip_angle_brackets),
            }
        })
        .try_collect()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))
}

/// Best-effort write-through into the local encrypted cache. Failures are
/// logged, not propagated -- IMAP stays the source of truth, the cache is
/// just a local mirror for future offline use, so a cache hiccup must
/// never turn a successful fetch into a user-visible error.
fn cache_summaries(account_id: &str, folder: &str, summaries: &[MessageSummary]) {
    let result = cache::open().and_then(|conn| cache::upsert_summaries(&conn, account_id, folder, summaries));
    if let Err(e) = result {
        log::warn!("could not update local message cache for {account_id}/{folder}: {e}");
    }
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

    if let Ok(summaries) = &result {
        cache_summaries(&account_id, &folder, summaries);
    }

    result
}

/// Recursively builds one `ThreadedMessage` from a slot vec, consuming
/// each slot exactly once. Called only from `group_into_threads`; not a
/// Tauri command.
fn build_thread(
    idx: usize,
    slots: &mut Vec<Option<MessageSummary>>,
    children: &[Vec<usize>],
) -> ThreadedMessage {
    let message = slots[idx].take().expect("each message placed in exactly one thread");
    let mut replies: Vec<ThreadedMessage> = children[idx]
        .iter()
        .map(|&child_idx| build_thread(child_idx, slots, children))
        .collect();
    replies.sort_by(|a, b| a.message.date.cmp(&b.message.date));
    ThreadedMessage { message, replies }
}

/// Groups a flat list of message summaries into conversation threads using
/// `In-Reply-To` / `Message-ID` matching.
///
/// Messages whose parent is absent from the list (or that have no
/// `in_reply_to`) become thread roots. Replies are nested directly under
/// their parent and sorted chronologically. Pathological cycles (A
/// replies to B, B replies to A) result in both messages being silently
/// dropped rather than an infinite loop -- this can't occur in real RFC
/// 5322 mail and isn't worth a more complex defence.
///
/// `pub` so `account.rs`'s `fetch_unified_inbox` can thread the merged
/// result in the future without duplicating this logic.
pub fn group_into_threads(messages: Vec<MessageSummary>) -> Vec<ThreadedMessage> {
    use std::collections::HashMap;

    // Map from message_id -> index. Messages without a message_id can't
    // be identified as parents, so they're excluded from the lookup.
    let id_to_idx: HashMap<&str, usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.message_id.as_deref().map(|id| (id, i)))
        .collect();

    // For each message, the index of its parent within this set -- None if
    // it's a root (no in_reply_to, or the parent isn't in this fetch).
    let parent_of: Vec<Option<usize>> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            m.in_reply_to
                .as_deref()
                .and_then(|pid| id_to_idx.get(pid).copied())
                .filter(|&p| p != i) // guard: message can't be its own parent
        })
        .collect();

    // Build the children list: children[p] = indices of messages whose
    // parent index is p.
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); messages.len()];
    for (i, opt_parent) in parent_of.iter().enumerate() {
        if let Some(p) = *opt_parent {
            children[p].push(i);
        }
    }

    // Move each MessageSummary into an Option slot so build_thread can
    // take ownership of them one at a time without cloning.
    let mut slots: Vec<Option<MessageSummary>> = messages.into_iter().map(Some).collect();

    let mut roots: Vec<ThreadedMessage> = parent_of
        .iter()
        .enumerate()
        .filter(|(_, p)| p.is_none())
        .map(|(i, _)| build_thread(i, &mut slots, &children))
        .collect();
    roots.sort_by(|a, b| a.message.date.cmp(&b.message.date));
    roots
}

/// Same as `fetch_messages` but groups the result into conversation threads
/// before returning. Caches the flat summary list (write-through) on the
/// way out, same as `fetch_messages` does.
#[tauri::command]
pub async fn fetch_threaded_messages(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    limit: u32,
) -> Result<Vec<ThreadedMessage>, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = fetch_recent_messages(&mut session, &folder, limit).await;
    session.logout().await.ok();

    let messages = result?;
    cache_summaries(&account_id, &folder, &messages);
    Ok(group_into_threads(messages))
}

#[derive(Debug, Serialize)]
pub struct AttachmentInfo {
    /// Position in the parsed message's attachment list -- pass this back
    /// to `fetch_attachment`/`pop3::fetch_attachment` to download this
    /// specific attachment's bytes. Stable for a given raw message, since
    /// it's just `parse_message_body`'s iteration order over the same
    /// `mail_parser::Message::attachments()` call both times.
    pub index: usize,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

/// One attachment's actual content, returned by `fetch_attachment`/
/// `pop3::fetch_attachment`. Deliberately a separate command from
/// `fetch_message_body` rather than an extra field there -- a message
/// preview has no use for attachment bytes, and fetching them eagerly
/// for every open would waste bandwidth on attachments nobody asked to
/// download.
#[derive(Debug, Serialize)]
pub struct AttachmentContent {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    /// Base64-encoded (standard alphabet). IPC payloads go through JSON,
    /// where a `Vec<u8>` would serialize as an array of numbers -- far
    /// more bytes over the wire than a base64 string for the same content.
    pub content_base64: String,
}

#[derive(Debug, Serialize)]
pub struct MessageBody {
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
    /// Set by `pgp::maybe_decrypt` when `text` turned out to be an
    /// inline-armored PGP message with a known signer -- `None` for
    /// ordinary mail, or encrypted mail whose signer isn't on file.
    pub pgp_signed_by: Option<String>,
    /// `None` for ordinary mail. `Some(false)`/`Some(true)` once
    /// decryption was attempted -- whether the signature actually
    /// verified, independent of whether the signer was known at all.
    pub pgp_signature_valid: Option<bool>,
    /// Formatted `"Name <email>"` (or just `"email"` with no display
    /// name) -- same convention as `MessageSummary.from`. Distinct from
    /// `parse_message_body`'s separate bare-email `sender_email` return
    /// value, which exists for PGP verification/contact harvesting and
    /// has no use for a display name.
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    /// RFC 5322 `Reply-To`, if the sender set one. A real Reply should
    /// prefer this over `from` when present -- that's the entire point of
    /// the header existing -- but resolving that preference is left to
    /// the caller composing the reply, not decided here.
    pub reply_to: Option<String>,
    /// This message's own `Message-ID`. What a reply to *this* message
    /// should put in its own `In-Reply-To`, and append to its own
    /// `References` (see `references` below and `smtp.rs`'s
    /// `send_message`). Angle brackets already stripped, same as
    /// `mail_parser`'s own `message_id()`/`references()` accessors.
    pub message_id: Option<String>,
    /// This message's own `In-Reply-To`, if it's itself a reply --
    /// groundwork for thread reconstruction (grouping messages by
    /// `References`/`In-Reply-To`/`Message-ID`), not used by reply/forward
    /// composition itself.
    pub in_reply_to: Option<String>,
    /// This message's own `References` chain. A reply to *this* message
    /// should send `references + [message_id]` as its own `References`
    /// (RFC 5322 section 3.6.4) -- that chaining is the caller's job, not
    /// done here, since this field is just what's already on the message.
    pub references: Vec<String>,
}

fn content_type_string(content_type: &mail_parser::ContentType) -> String {
    match &content_type.c_subtype {
        Some(subtype) => format!("{}/{}", content_type.c_type, subtype),
        None => content_type.c_type.to_string(),
    }
}

/// Formats one already-parsed address as `"Name <email>"`, or just
/// `"email"` with no display name. Same convention as this module's own
/// `format_address` above, just for `mail_parser::Addr` instead of
/// `imap_proto`'s address type -- can't share the name `format_address`
/// for both, since Rust doesn't dispatch free functions by parameter type.
fn format_parsed_address(addr: &mail_parser::Addr) -> String {
    let email = addr.address().unwrap_or_default();
    match addr.name() {
        Some(name) if !name.is_empty() => format!("{name} <{email}>"),
        _ => email.to_string(),
    }
}

/// Flattens an optional address-list header (`To`/`Cc`) into formatted
/// strings, one per address -- `None` (header absent) and an empty list
/// both come back as an empty `Vec`, so callers don't need to distinguish
/// the two.
fn format_address_list(address: Option<&mail_parser::Address>) -> Vec<String> {
    address
        .map(|addr| addr.iter().map(format_parsed_address).collect())
        .unwrap_or_default()
}

/// Flattens a `Message-ID`/`In-Reply-To`/`References`-shaped header value
/// into a list of IDs (angle brackets already stripped by `mail_parser`'s
/// own parsing). These headers parse to `HeaderValue::Text` when there's
/// exactly one ID, `HeaderValue::TextList` for more than one, or `Empty`
/// when the header is absent -- this collapses all three into one `Vec`
/// rather than making every caller match on the variant itself.
fn header_value_to_id_list(value: &mail_parser::HeaderValue) -> Vec<String> {
    if let Some(list) = value.as_text_list() {
        list.iter().map(|s| s.to_string()).collect()
    } else if let Some(text) = value.as_text() {
        vec![text.to_string()]
    } else {
        Vec::new()
    }
}

/// Pulls `(email, display_name)` candidates for the local contact cache
/// out of an already-parsed message's From/To/Cc headers. Opening a
/// message to read it is a genuine "I interacted with this address"
/// signal for the sender and every other recipient on the thread, unlike
/// a folder listing -- which is why this lives here rather than in
/// `fetch_recent_messages`.
fn extract_contact_candidates(message: &mail_parser::Message) -> Vec<(String, Option<String>)> {
    let mut candidates = Vec::new();
    for header in [message.from(), message.to(), message.cc()] {
        let Some(address) = header else { continue };
        for addr in address.iter() {
            if let Some(email) = addr.address() {
                candidates.push((email.to_string(), addr.name().map(|name| name.to_string())));
            }
        }
    }
    candidates
}

/// Parses raw RFC 822 message bytes into a plain text body, an HTML body
/// (if present), attachment metadata, the sender's email (for PGP
/// signature verification -- see `pgp::maybe_decrypt`), and contact
/// candidates harvested from the From/To/Cc headers. Shared by both the
/// IMAP (`BODY[]`) and POP3 (`RETR`) fetch paths -- once you have the raw
/// bytes of a message, there's no protocol-specific difference left in
/// turning them into a `MessageBody`.
pub(crate) fn parse_message_body(
    raw_message: &[u8],
) -> Result<(MessageBody, Option<String>, Vec<(String, Option<String>)>), String> {
    let message = mail_parser::MessageParser::default()
        .parse(raw_message)
        .ok_or_else(|| "could not parse message content".to_string())?;

    let sender_email = message
        .from()
        .and_then(|address| address.iter().next())
        .and_then(|addr| addr.address())
        .map(|s| s.to_string());
    let contacts = extract_contact_candidates(&message);
    let text = message.body_text(0).map(|s| s.into_owned());
    let html = message.body_html(0).map(|s| s.into_owned());
    let attachments = message
        .attachments()
        .enumerate()
        .map(|(index, part)| AttachmentInfo {
            index,
            filename: part.attachment_name().map(|s| s.to_string()),
            content_type: part.content_type().map(content_type_string),
            size: part.len(),
        })
        .collect();

    let from = message.from().and_then(|address| address.first()).map(format_parsed_address);
    let to = format_address_list(message.to());
    let cc = format_address_list(message.cc());
    let reply_to = message.reply_to().and_then(|address| address.first()).map(format_parsed_address);
    let message_id = message.message_id().map(|s| s.to_string());
    let in_reply_to = header_value_to_id_list(message.in_reply_to()).into_iter().next();
    let references = header_value_to_id_list(message.references());

    Ok((
        MessageBody {
            text,
            html,
            attachments,
            pgp_signed_by: None,
            pgp_signature_valid: None,
            from,
            to,
            cc,
            reply_to,
            message_id,
            in_reply_to,
            references,
        },
        sender_email,
        contacts,
    ))
}

/// Re-parses a message's raw bytes and pulls out one attachment's already-
/// decoded content (`mail_parser` undoes base64/quoted-printable for us) by
/// its position in `parse_message_body`'s attachment list.
///
/// This re-fetches and re-parses the whole message rather than asking IMAP
/// for just the one MIME part via `BODY[<section>]` -- that would save
/// bandwidth on large messages, but needs mapping `mail_parser`'s
/// attachment ordering to IMAP's own section-number scheme, which isn't
/// implemented yet. Revisit if large attachments make that cost real;
/// not worth the complexity speculatively.
pub(crate) fn extract_attachment(raw_message: &[u8], attachment_index: usize) -> Result<AttachmentContent, String> {
    use base64::Engine;

    let message = mail_parser::MessageParser::default()
        .parse(raw_message)
        .ok_or_else(|| "could not parse message content".to_string())?;

    let part = message
        .attachments()
        .nth(attachment_index)
        .ok_or_else(|| format!("no attachment at index {attachment_index}"))?;

    Ok(AttachmentContent {
        filename: part.attachment_name().map(|s| s.to_string()),
        content_type: part.content_type().map(content_type_string),
        content_base64: base64::engine::general_purpose::STANDARD.encode(part.contents()),
    })
}

/// Opens `folder` and fetches one message's raw RFC 822 bytes by UID.
/// Split out from `fetch_body_by_uid` so `fetch_attachment` can re-fetch
/// the same raw bytes without going through the full body-parsing path.
/// `pub(crate)`, same reason as `fetch_body_by_uid` below -- `smtp.rs`'s
/// GreenMail round-trip test needs it to verify a sent attachment landed
/// correctly, over a session it authenticates itself.
///
/// `SELECT`, not `EXAMINE` — unlike `fetch_messages`, this represents the
/// user actually opening a message to read it (or download something from
/// it), so marking it `\Seen` is expected, same as any other mail client.
pub(crate) async fn fetch_raw_message_by_uid(session: &mut ImapSession, folder: &str, uid: u32) -> Result<Vec<u8>, String> {
    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    session
        .uid_fetch(uid.to_string(), "BODY[]")
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .try_next()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .and_then(|fetch| fetch.body().map(|b| b.to_vec()))
        .ok_or_else(|| format!("no message with UID {uid} in {folder}"))
}

/// Fetches the full content of a single message by UID via IMAP.
/// `pub(crate)` (not just module-private) so `smtp.rs`'s GreenMail
/// encrypt/decrypt round-trip test can fetch a message back over a
/// session it authenticates itself, the same way it already builds its
/// own permissive-TLS SMTP transport instead of going through
/// `send_message`'s certificate-validating path.
pub(crate) async fn fetch_body_by_uid(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<(MessageBody, Option<String>, Vec<(String, Option<String>)>), String> {
    let raw_message = fetch_raw_message_by_uid(session, folder, uid).await?;
    parse_message_body(&raw_message)
}

/// Same best-effort, log-and-continue caching as `cache_summaries`, for a
/// single message body.
fn cache_body(account_id: &str, folder: &str, uid: u32, body: &MessageBody) {
    let result = cache::open().and_then(|conn| cache::upsert_body(&conn, account_id, folder, uid, body));
    if let Err(e) = result {
        log::warn!("could not update local message cache for {account_id}/{folder}/{uid}: {e}");
    }
}

/// Same best-effort, log-and-continue caching as `cache_body`, for the
/// contact candidates harvested alongside it.
fn cache_contacts(contacts: &[(String, Option<String>)]) {
    if contacts.is_empty() {
        return;
    }
    let result = cache::open().and_then(|conn| cache::upsert_contacts(&conn, contacts));
    if let Err(e) = result {
        log::warn!("could not update local contact cache: {e}");
    }
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

    let (body, sender_email, contacts) = result?;
    cache_body(&account_id, &folder, uid, &body);
    cache_contacts(&contacts);
    let body = pgp::maybe_decrypt(&account_id, sender_email.as_deref(), body);

    Ok(body)
}

#[tauri::command]
pub async fn fetch_attachment(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
    attachment_index: usize,
) -> Result<AttachmentContent, String> {
    let mut session = login_with_stored_credential(&host, port, &account_id).await?;
    let result = fetch_raw_message_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();

    extract_attachment(&result?, attachment_index)
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

        let (body, sender_email, contacts) = fetch_body_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");

        session.logout().await.ok();

        assert_eq!(body.text.as_deref(), Some("This is the plain text body."));
        assert!(body.html.unwrap().contains("<b>HTML</b>"));
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].index, 0);
        assert_eq!(body.attachments[0].filename.as_deref(), Some("document.pdf"));
        assert_eq!(body.attachments[0].content_type.as_deref(), Some("application/pdf"));
        assert!(body.attachments[0].size > 0);

        assert_eq!(sender_email.as_deref(), Some("sender@helix.test"));
        assert_eq!(body.from.as_deref(), Some("Sender Name <sender@helix.test>"));
        assert_eq!(body.to, vec!["helix@helix.test".to_string()]);

        assert!(
            contacts.contains(&("sender@helix.test".to_string(), Some("Sender Name".to_string()))),
            "the From address with its display name should be a contact candidate"
        );
        assert!(
            contacts.contains(&("helix@helix.test".to_string(), None)),
            "the To address with no display name should still be a contact candidate"
        );
    }

    // Same fixture as the test above, exercising fetch_attachment's own
    // path (a fresh raw FETCH + extract_attachment) rather than going
    // through fetch_body_by_uid/parse_message_body's metadata-only listing.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/imap-core.md"]
    async fn fetches_an_attachment_from_a_local_test_server() {
        use base64::Engine;

        let mut session = connect_to_greenmail_and_login().await;

        let raw_message = fetch_raw_message_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("raw fetch should succeed");
        session.logout().await.ok();

        let attachment = extract_attachment(&raw_message, 0).expect("attachment should be present");

        assert_eq!(attachment.filename.as_deref(), Some("document.pdf"));
        assert_eq!(attachment.content_type.as_deref(), Some("application/pdf"));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&attachment.content_base64)
            .expect("content should be valid base64");
        assert_eq!(decoded, b"fake pdf bytes here");
    }

    fn summary_with_threading(uid: u32, message_id: &str, in_reply_to: Option<&str>) -> MessageSummary {
        MessageSummary {
            uid: Some(uid),
            subject: Some(format!("Message {uid}")),
            from: Some("sender@helix.test".to_string()),
            date: Some(format!("2026-06-26T0{uid}:00:00+00:00")),
            seen: false,
            flagged: false,
            message_id: Some(message_id.to_string()),
            in_reply_to: in_reply_to.map(|s| s.to_string()),
        }
    }

    #[test]
    fn group_into_threads_builds_a_linear_reply_chain() {
        let messages = vec![
            summary_with_threading(1, "root@h.test", None),
            summary_with_threading(2, "reply@h.test", Some("root@h.test")),
            summary_with_threading(3, "reply2@h.test", Some("reply@h.test")),
        ];

        let threads = group_into_threads(messages);

        assert_eq!(threads.len(), 1, "three chained messages form one thread");
        assert_eq!(threads[0].message.uid, Some(1));
        assert_eq!(threads[0].replies.len(), 1);
        assert_eq!(threads[0].replies[0].message.uid, Some(2));
        assert_eq!(threads[0].replies[0].replies.len(), 1);
        assert_eq!(threads[0].replies[0].replies[0].message.uid, Some(3));
    }

    #[test]
    fn group_into_threads_keeps_unrelated_messages_as_separate_roots() {
        let messages = vec![
            summary_with_threading(1, "a@h.test", None),
            summary_with_threading(2, "b@h.test", None),
        ];

        let threads = group_into_threads(messages);

        assert_eq!(threads.len(), 2, "two independent messages form two threads");
        assert!(threads.iter().all(|t| t.replies.is_empty()));
    }

    #[test]
    fn group_into_threads_treats_orphaned_replies_as_roots() {
        // Message 2's parent isn't in the fetch window, so it becomes a root.
        let messages = vec![
            summary_with_threading(1, "child@h.test", Some("missing-parent@h.test")),
        ];

        let threads = group_into_threads(messages);

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].message.uid, Some(1));
        assert!(threads[0].replies.is_empty(), "no parent in set → no nesting");
    }

    #[test]
    fn group_into_threads_sorts_roots_and_replies_by_date() {
        // Root R with two replies, but reply UID 3 has an earlier date than UID 2.
        let mut messages = vec![
            summary_with_threading(1, "root@h.test", None),
            summary_with_threading(2, "late-reply@h.test", Some("root@h.test")),
            summary_with_threading(3, "early-reply@h.test", Some("root@h.test")),
        ];
        // Override dates so 3 is earlier than 2.
        messages[1].date = Some("2026-06-26T10:00:00+00:00".to_string());
        messages[2].date = Some("2026-06-26T09:00:00+00:00".to_string());

        let threads = group_into_threads(messages);

        assert_eq!(threads.len(), 1);
        let replies = &threads[0].replies;
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0].message.uid, Some(3), "earlier reply first");
        assert_eq!(replies[1].message.uid, Some(2));
    }

    // Pure, no network: builds a small multipart message by hand to prove
    // extract_attachment's index lookup and base64 encoding work in
    // isolation from any real mail server.
    #[test]
    fn extract_attachment_decodes_the_requested_part_by_index() {
        use base64::Engine;

        let raw_message = b"From: sender@example.com\r\n\
To: recipient@example.com\r\n\
Subject: test\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"BOUNDARY\"\r\n\
\r\n\
--BOUNDARY\r\n\
Content-Type: text/plain\r\n\
\r\n\
body text\r\n\
--BOUNDARY\r\n\
Content-Type: text/plain\r\n\
Content-Disposition: attachment; filename=\"notes.txt\"\r\n\
\r\n\
attachment contents\r\n\
--BOUNDARY--\r\n";

        let attachment = extract_attachment(raw_message, 0).expect("attachment at index 0 should exist");
        assert_eq!(attachment.filename.as_deref(), Some("notes.txt"));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&attachment.content_base64)
            .expect("content should be valid base64");
        assert_eq!(decoded, b"attachment contents");

        let err = extract_attachment(raw_message, 1).expect_err("there is no second attachment");
        assert!(err.contains("no attachment at index 1"));
    }

    // Pure, no network: hand-builds a reply-shaped message (multiple To/Cc
    // recipients, a Reply-To distinct from From, and a References chain
    // with more than one ID) to prove parse_message_body's header
    // extraction -- the groundwork reply/forward composition and (later)
    // message threading both need -- works correctly in isolation,
    // including the multi-ID TextList case a single-recipient/single-
    // reference fixture wouldn't exercise.
    #[test]
    fn parse_message_body_extracts_recipients_and_threading_headers() {
        let raw_message = b"From: Sender Name <sender@example.com>\r\n\
Reply-To: Sender Support <support@example.com>\r\n\
To: First Recipient <first@example.com>, second@example.com\r\n\
Cc: Watcher <watcher@example.com>\r\n\
Subject: Re: original subject\r\n\
Message-ID: <reply-id@example.com>\r\n\
In-Reply-To: <original-id@example.com>\r\n\
References: <root-id@example.com> <original-id@example.com>\r\n\
\r\n\
body text\r\n";

        let (body, sender_email, _contacts) = parse_message_body(raw_message).expect("parse should succeed");

        assert_eq!(body.from.as_deref(), Some("Sender Name <sender@example.com>"));
        assert_eq!(sender_email.as_deref(), Some("sender@example.com"));
        assert_eq!(body.reply_to.as_deref(), Some("Sender Support <support@example.com>"));
        assert_eq!(
            body.to,
            vec!["First Recipient <first@example.com>".to_string(), "second@example.com".to_string()]
        );
        assert_eq!(body.cc, vec!["Watcher <watcher@example.com>".to_string()]);
        assert_eq!(body.message_id.as_deref(), Some("reply-id@example.com"));
        assert_eq!(body.in_reply_to.as_deref(), Some("original-id@example.com"));
        assert_eq!(
            body.references,
            vec!["root-id@example.com".to_string(), "original-id@example.com".to_string()]
        );
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
