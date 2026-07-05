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
use crate::smime;

pub(crate) type ImapSession = Session<TlsStream<TcpStream>>;

// `use_starttls = false` → implicit TLS (IMAPS/993); `true` → STARTTLS upgrade on 143.
// STARTTLS upgrade is mandatory — bails out if the server won't do it, never continues plaintext.
async fn connect_and_login(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
    use_starttls: bool,
) -> Result<ImapSession, String> {
    let tcp_stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;

    let tls_connector = TlsConnector::from(
        tokio_native_tls::native_tls::TlsConnector::new()
            .map_err(|e| format!("TLS setup failed: {e}"))?,
    );

    let tls_stream = if use_starttls {
        // async-imap absorbs the server greeting while parsing the STARTTLS response,
        // so there's no separate greeting read here.
        let mut client = async_imap::Client::new(tcp_stream);
        client
            .run_command_and_check_ok("STARTTLS", None)
            .await
            .map_err(|e| format!("STARTTLS failed: {e}"))?;
        let upgraded = client.into_inner();
        tls_connector
            .connect(host, upgraded)
            .await
            .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?
    } else {
        tls_connector
            .connect(host, tcp_stream)
            .await
            .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?
    };

    let client = async_imap::Client::new(tls_stream);
    client
        .login(email, password)
        .await
        .map_err(|(e, _client)| format!("login failed: {e}"))
}

// Password is zeroized immediately after the login attempt, success or failure.
pub(crate) async fn login_with_stored_credential(
    host: &str,
    port: u16,
    account_id: &str,
    use_starttls: bool,
) -> Result<ImapSession, String> {
    let mut password = credentials::get_credential(account_id.to_string())?;
    let result = connect_and_login(host, port, account_id, &password, use_starttls).await;
    password.zeroize();
    result
}

// Resolves imap_use_starttls from the cache so callers don't have to pass it.
// Defaults to false (implicit TLS) when the lookup fails — overwhelmingly the common case.
pub(crate) async fn login_for_account(
    host: &str,
    port: u16,
    account_id: &str,
) -> Result<ImapSession, String> {
    let use_starttls = cache::open()
        .and_then(|conn| cache::get_account(&conn, account_id))
        .ok()
        .flatten()
        .map(|a| a.imap_use_starttls)
        .unwrap_or(false);
    login_with_stored_credential(host, port, account_id, use_starttls).await
}

// pub(crate) alias so smtp.rs/drafts.rs can LIST inside a session they
// already hold when healing a bad special-folder name after a failed APPEND.
pub(crate) async fn list_folder_names(session: &mut ImapSession) -> Result<Vec<String>, String> {
    collect_folder_names(session).await
}

async fn collect_folder_names(session: &mut ImapSession) -> Result<Vec<String>, String> {
    session
        .list(None, Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {e}"))?
        .map_ok(|name| name.name().to_string())
        .try_collect()
        .await
        .map_err(|e| format!("LIST failed: {e}"))
}

/// The last path segment of an IMAP folder name -- "INBOX.Sent" and
/// "[Gmail]/Sent Mail" both need to be recognized by what they're called,
/// not where they sit in the hierarchy. Splits on both common delimiters;
/// a folder legitimately containing '.' in its leaf name only matters here
/// if that leaf also collides with a special-folder synonym, which is a
/// harmless false positive (we'd still pick a folder the user calls Sent).
fn folder_leaf(name: &str) -> &str {
    name.rsplit(['/', '.']).next().unwrap_or(name)
}

/// Maps a special-mailbox role to the leaf names servers actually use for
/// it. Order matters: earlier synonyms win when a server has several
/// candidates (e.g. both "INBOX.spam" and "INBOX.Junk" exist in the wild
/// on the same account).
fn special_folder_synonyms(role: &str) -> &'static [&'static str] {
    match role {
        "sent" => &["sent", "sent items", "sent mail", "sent messages", "sent-mail"],
        "trash" => &["trash", "deleted items", "deleted messages", "deleted", "bin"],
        "archive" => &["archive", "archives", "all mail"],
        "drafts" => &["drafts", "draft"],
        "spam" => &["spam", "junk", "junk mail", "junk e-mail", "bulk mail"],
        _ => &[],
    }
}

/// Picks the real server folder for a special-mailbox role out of a LIST
/// response. Hardcoded defaults like "Sent" name a folder that simply
/// doesn't exist on providers that nest everything under the INBOX
/// namespace (cPanel/Dovecot's "INBOX.Sent") or a display prefix (Gmail's
/// "[Gmail]/Sent Mail") -- this resolves by leaf name instead. Ties go to
/// the shortest full name, i.e. the least-nested candidate.
pub(crate) fn resolve_special_folder(folders: &[String], role: &str) -> Option<String> {
    for synonym in special_folder_synonyms(role) {
        let mut candidates: Vec<&String> = folders
            .iter()
            .filter(|f| folder_leaf(f).eq_ignore_ascii_case(synonym))
            .collect();
        candidates.sort_by_key(|f| f.len());
        if let Some(found) = candidates.first() {
            return Some((*found).to_string());
        }
    }
    None
}

/// Finds the folder a caller-supplied name was *meant* to address when the
/// name itself isn't in the LIST response: first a leaf-name match (asked
/// for "Sent", server has "INBOX.Sent"), then role synonyms (asked for
/// "Spam", server only has "INBOX.Junk"). Returns None when the requested
/// folder exists as-is (nothing to heal) or nothing plausible matches.
pub(crate) fn resolve_equivalent_folder(folders: &[String], requested: &str) -> Option<String> {
    if folders.iter().any(|f| f == requested) {
        return None;
    }
    let requested_leaf = folder_leaf(requested);
    let mut leaf_matches: Vec<&String> = folders
        .iter()
        .filter(|f| folder_leaf(f).eq_ignore_ascii_case(requested_leaf))
        .collect();
    leaf_matches.sort_by_key(|f| f.len());
    if let Some(found) = leaf_matches.first() {
        return Some((*found).to_string());
    }
    for role in ["sent", "trash", "archive", "drafts", "spam"] {
        if special_folder_synonyms(role)
            .iter()
            .any(|s| s.eq_ignore_ascii_case(requested_leaf))
        {
            return resolve_special_folder(folders, role);
        }
    }
    None
}

/// Rewrites any special-folder field on the cached account record that
/// still holds `wrong` to `correct`, so a runtime folder-name heal (a
/// failed APPEND or move that succeeded on retry against the real folder)
/// sticks for every later operation instead of re-failing each time.
pub(crate) fn persist_folder_correction(account_id: &str, wrong: &str, correct: &str) {
    let result = cache::open().and_then(|conn| {
        let Some(mut account) = cache::get_account(&conn, account_id)? else {
            return Ok(());
        };
        let mut changed = false;
        for field in [
            &mut account.sent_folder,
            &mut account.trash_folder,
            &mut account.archive_folder,
            &mut account.drafts_folder,
            &mut account.spam_folder,
        ] {
            if field == wrong {
                *field = correct.to_string();
                changed = true;
            }
        }
        if changed {
            cache::upsert_account(&conn, &account)?;
        }
        Ok(())
    });
    if let Err(e) = result {
        log::warn!("could not persist folder correction {wrong} -> {correct} for {account_id}: {e}");
    }
}

#[tauri::command]
pub async fn list_folders(
    account_id: String,
    host: String,
    port: u16,
) -> Result<Vec<String>, String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let folders = collect_folder_names(&mut session).await;
    session.logout().await.ok();
    folders
}

// Used during onboarding before the account is persisted — can't use login_for_account
// yet because the cache lookup would fall back to the wrong default.
pub(crate) async fn verify_and_list_folders(
    host: &str,
    port: u16,
    account_id: &str,
    use_starttls: bool,
) -> Result<Vec<String>, String> {
    let mut session = login_with_stored_credential(host, port, account_id, use_starttls).await?;
    let folders = collect_folder_names(&mut session).await;
    session.logout().await.ok();
    folders
}

#[derive(Debug, Serialize)]
pub struct MessageSummary {
    pub uid: Option<u32>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub seen: bool,
    pub flagged: bool,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    /// Client-side only — never touches a server flag. False when the model is undertrained.
    pub is_spam: bool,
}

#[derive(Debug, Serialize)]
pub struct ThreadedMessage {
    pub message: MessageSummary,
    pub replies: Vec<ThreadedMessage>,
}

// IMAP ENVELOPE includes angle brackets on message IDs; strip them so they
// compare equal to what mail_parser returns from the parsed body.
fn strip_angle_brackets(s: String) -> String {
    let t = s.trim();
    if t.starts_with('<') && t.ends_with('>') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

// Addresses are ASCII-only by protocol, so no RFC 2047 decoding needed.
fn decode_lossy(bytes: &Option<Cow<[u8]>>) -> Option<String> {
    bytes
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
}

// Handles RFC 2047 encoded words (non-ASCII subjects/display names); falls back to lossy UTF-8.
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

// Shared by range-fetch and search-result-fetch — both request the same FETCH items.
fn summary_from_fetch(fetch: &async_imap::types::Fetch) -> MessageSummary {
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
        is_spam: false,
    }
}

// EXAMINE, not SELECT — preview-only, must not mark messages seen.
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
        .map_ok(|fetch| summary_from_fetch(&fetch))
        .try_collect()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))
}

// CR/LF stripped (would terminate the command line); backslash and quote escaped.
fn imap_quote(value: &str) -> String {
    let cleaned: String = value.chars().filter(|&c| c != '\r' && c != '\n').collect();
    let escaped = cleaned.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

// IMAP OR is binary, so a four-way match is a left-folded chain: OR OR OR SUBJECT FROM TO BODY.
fn build_search_criteria(query: &str) -> String {
    let q = imap_quote(query);
    format!("OR OR OR SUBJECT {q} FROM {q} TO {q} BODY {q}")
}

// Non-ASCII queries get CHARSET UTF-8; pure-ASCII omits it since some servers reject
// the explicit CHARSET even when the default would be fine.
async fn search_in_folder(
    session: &mut ImapSession,
    folder: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    if query.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    session
        .examine(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let criteria = build_search_criteria(query);
    let full = if query.bytes().any(|b| b >= 0x80) {
        format!("CHARSET UTF-8 {criteria}")
    } else {
        criteria
    };

    let matches = session
        .uid_search(full)
        .await
        .map_err(|e| format!("SEARCH failed: {e}"))?;
    if matches.is_empty() {
        return Ok(Vec::new());
    }

    // Highest UIDs first; cap at limit so a broad query doesn't pull thousands of messages.
    let mut uids: Vec<u32> = matches.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(limit as usize);

    let uid_set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let mut summaries: Vec<MessageSummary> = session
        .uid_fetch(uid_set, "(UID FLAGS ENVELOPE INTERNALDATE)")
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?
        .map_ok(|fetch| summary_from_fetch(&fetch))
        .try_collect()
        .await
        .map_err(|e| format!("FETCH failed: {e}"))?;

    // Server may return rows in any order; sort to match the newest-first truncation above.
    summaries.sort_unstable_by(|a, b| b.uid.cmp(&a.uid));
    Ok(summaries)
}

#[tauri::command]
pub async fn search_messages(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    query: String,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = search_in_folder(&mut session, &folder, &query, limit).await;
    session.logout().await.ok();
    result
}

/// The mailbox-name prefix new top-level folders need on this server, if
/// any. Providers that nest user mailboxes under the INBOX namespace
/// (cPanel/Dovecot) reject a bare `CREATE Projects` -- everything they LIST
/// besides INBOX itself starts with "INBOX." (or "INBOX/"), and new folders
/// must too. Detected from the LIST response rather than NAMESPACE, which
/// async-imap doesn't expose a typed API for.
fn detect_namespace_prefix(folders: &[String]) -> Option<String> {
    for delimiter in ['.', '/'] {
        let prefix = format!("INBOX{delimiter}");
        let non_inbox: Vec<&String> = folders.iter().filter(|f| f.as_str() != "INBOX").collect();
        if !non_inbox.is_empty() && non_inbox.iter().all(|f| f.starts_with(&prefix)) {
            return Some(prefix);
        }
    }
    None
}

#[tauri::command]
pub async fn create_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = async {
        let first_error = match session.create(&folder).await {
            Ok(()) => return Ok(()),
            Err(e) => format!("could not create folder {folder}: {e}"),
        };
        // Retry inside the server's INBOX namespace if it has one -- the
        // caller passes the bare name the user typed, which many providers
        // only accept as "INBOX.<name>".
        let folders = collect_folder_names(&mut session).await.map_err(|_| first_error.clone())?;
        let Some(prefix) = detect_namespace_prefix(&folders) else {
            return Err(first_error);
        };
        let prefixed = format!("{prefix}{folder}");
        session
            .create(&prefixed)
            .await
            .map_err(|e| format!("could not create folder {folder} (or {prefixed}): {e}"))
    }
    .await;
    session.logout().await.ok();
    result
}

#[tauri::command]
pub async fn delete_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = session
        .delete(&folder)
        .await
        .map_err(|e| format!("could not delete folder {folder}: {e}"));
    session.logout().await.ok();
    result
}

#[tauri::command]
pub async fn rename_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    new_name: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = session
        .rename(&folder, &new_name)
        .await
        .map_err(|e| format!("could not rename folder {folder} to {new_name}: {e}"));
    session.logout().await.ok();
    result
}

// Some servers error on 1:* STORE against an empty mailbox, so bail early in that case.
async fn empty_folder_messages(session: &mut ImapSession, folder: &str) -> Result<(), String> {
    let mailbox = session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    if mailbox.exists == 0 {
        return Ok(());
    }

    session
        .uid_store("1:*", "+FLAGS.SILENT (\\Deleted)")
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

#[tauri::command]
pub async fn empty_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = empty_folder_messages(&mut session, &folder).await;
    session.logout().await.ok();
    result
}

#[tauri::command]
pub async fn subscribe_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = session
        .subscribe(&folder)
        .await
        .map_err(|e| format!("SUBSCRIBE failed for {folder}: {e}"));
    session.logout().await.ok();
    result
}

#[tauri::command]
pub async fn unsubscribe_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = session
        .unsubscribe(&folder)
        .await
        .map_err(|e| format!("UNSUBSCRIBE failed for {folder}: {e}"));
    session.logout().await.ok();
    result
}

// LSUB instead of LIST — returns only explicitly subscribed folders.
#[tauri::command]
pub async fn list_subscribed_folders(
    account_id: String,
    host: String,
    port: u16,
) -> Result<Vec<String>, String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = session
        .lsub(None, Some("*"))
        .await
        .map_err(|e| format!("LSUB failed: {e}"))?
        .map_ok(|name| name.name().to_string())
        .try_collect()
        .await
        .map_err(|e| format!("LSUB failed: {e}"));
    session.logout().await.ok();
    result
}

// Cache failures are logged, never surfaced — IMAP is the source of truth.
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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = fetch_recent_messages(&mut session, &folder, limit).await;
    session.logout().await.ok();

    if let Ok(summaries) = &result {
        cache_summaries(&account_id, &folder, summaries);
    }

    // Spam scoring is best-effort — failures leave is_spam = false, never break the fetch.
    let mut result = result;
    if let Ok(summaries) = &mut result {
        if let Ok(conn) = cache::open() {
            for s in summaries.iter_mut() {
                s.is_spam = crate::bayes::score_summary(&conn, s.subject.as_deref(), s.from.as_deref());
            }
        }
    }

    result
}

// Takes ownership of each slot exactly once via Option::take.
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

// Cycles (A replies to B, B replies to A) can't occur in real mail but are silently dropped
// rather than looping — not worth defending against more explicitly.
pub fn group_into_threads(messages: Vec<MessageSummary>) -> Vec<ThreadedMessage> {
    use std::collections::HashMap;

    let id_to_idx: HashMap<&str, usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.message_id.as_deref().map(|id| (id, i)))
        .collect();

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

    let mut children: Vec<Vec<usize>> = vec![Vec::new(); messages.len()];
    for (i, opt_parent) in parent_of.iter().enumerate() {
        if let Some(p) = *opt_parent {
            children[p].push(i);
        }
    }

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

// Apply spam scoring before threading so is_spam is visible on summaries inside the tree.
#[tauri::command]
pub async fn fetch_threaded_messages(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    limit: u32,
) -> Result<Vec<ThreadedMessage>, String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = fetch_recent_messages(&mut session, &folder, limit).await;
    session.logout().await.ok();

    let mut messages = result?;
    cache_summaries(&account_id, &folder, &messages);
    // Apply Bayesian spam scoring before threading so the is_spam flag is
    // visible on summaries inside the returned ThreadedMessage tree.
    if let Ok(conn) = cache::open() {
        for s in messages.iter_mut() {
            s.is_spam = crate::bayes::score_summary(&conn, s.subject.as_deref(), s.from.as_deref());
        }
    }
    Ok(group_into_threads(messages))
}

#[derive(Debug, Serialize)]
pub struct AttachmentInfo {
    pub index: usize,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size: usize,
}

#[derive(Debug, Serialize)]
pub struct AttachmentContent {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    /// Base64-encoded — Vec<u8> would serialize as a JSON array of numbers (much larger).
    pub content_base64: String,
}

#[derive(Debug, Serialize)]
pub struct MessageBody {
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
    pub pgp_signed_by: Option<String>,
    pub pgp_signature_valid: Option<bool>,
    pub smime_signed: bool,
    /// `None` = not signed (or detection not attempted); `Some(true/false)` = verified/failed.
    pub smime_verified: Option<bool>,
    pub smime_encrypted: bool,
    /// Email address extracted from the signer's X.509 certificate SAN/emailAddress RDN.
    pub smime_signer_email: Option<String>,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    /// RFC 5322 `Reply-To`, if the sender set one. A real Reply should
    /// prefer this over `from` when present -- that's the entire point of
    /// the header existing -- but resolving that preference is left to
    /// the caller composing the reply, not decided here.
    pub reply_to: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// Non-empty when the sender requested a read receipt (`Disposition-Notification-To` header).
    /// Contains the address to send the MDN to.
    pub disposition_notification_to: Option<String>,
}

fn content_type_string(content_type: &mail_parser::ContentType) -> String {
    match &content_type.c_subtype {
        Some(subtype) => format!("{}/{}", content_type.c_type, subtype),
        None => content_type.c_type.to_string(),
    }
}

fn format_parsed_address(addr: &mail_parser::Addr) -> String {
    let email = addr.address().unwrap_or_default();
    match addr.name() {
        Some(name) if !name.is_empty() => format!("{name} <{email}>"),
        _ => email.to_string(),
    }
}

fn format_address_list(address: Option<&mail_parser::Address>) -> Vec<String> {
    address
        .map(|addr| addr.iter().map(format_parsed_address).collect())
        .unwrap_or_default()
}

// HeaderValue is Text, TextList, or Empty depending on how many IDs are present — flatten all three.
fn header_value_to_id_list(value: &mail_parser::HeaderValue) -> Vec<String> {
    if let Some(list) = value.as_text_list() {
        list.iter().map(|s| s.to_string()).collect()
    } else if let Some(text) = value.as_text() {
        vec![text.to_string()]
    } else {
        Vec::new()
    }
}

// Harvested on open (not on folder listing) — opening a message is an actual correspondence signal.
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

// pub(crate) so pop3.rs can reuse — once you have raw bytes, parsing is identical.
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
    let disposition_notification_to = message
        .header("Disposition-Notification-To")
        .and_then(|v| v.as_text())
        .map(|s| s.to_string());

    Ok((
        MessageBody {
            text,
            html,
            attachments,
            pgp_signed_by: None,
            pgp_signature_valid: None,
            smime_signed: false,
            smime_verified: None,
            smime_encrypted: false,
            smime_signer_email: None,
            from,
            to,
            cc,
            reply_to,
            message_id,
            in_reply_to,
            references,
            disposition_notification_to,
        },
        sender_email,
        contacts,
    ))
}

// Re-parses the whole message rather than a BODY[section] partial fetch — mapping mail_parser's
// attachment ordering to IMAP section numbers isn't implemented; revisit if large attachments hurt.
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

// SELECT, not EXAMINE — marking \Seen is intentional when the user opens a message.
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

pub(crate) async fn fetch_body_by_uid(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<(MessageBody, Option<String>, Vec<(String, Option<String>)>), String> {
    let raw_message = fetch_raw_message_by_uid(session, folder, uid).await?;
    parse_message_body(&raw_message)
}

fn cache_body(account_id: &str, folder: &str, uid: u32, body: &MessageBody) {
    let result = cache::open().and_then(|conn| cache::upsert_body(&conn, account_id, folder, uid, body));
    if let Err(e) = result {
        log::warn!("could not update local message cache for {account_id}/{folder}/{uid}: {e}");
    }
}

fn cache_attachment(account_id: &str, folder: &str, uid: u32, idx: usize, content: &AttachmentContent) {
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&content.content_base64) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("could not decode attachment for caching ({account_id}/{folder}/{uid}#{idx}): {e}");
            return;
        }
    };
    let result = cache::open().and_then(|conn| {
        cache::upsert_attachment(
            &conn,
            account_id,
            folder,
            uid,
            idx,
            content.filename.as_deref(),
            content.content_type.as_deref(),
            &bytes,
        )
    });
    if let Err(e) = result {
        log::warn!("could not cache attachment {account_id}/{folder}/{uid}#{idx}: {e}");
    }
}

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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let raw_result = fetch_raw_message_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();

    let raw = raw_result?;
    let (body, sender_email, contacts) = parse_message_body(&raw)?;
    cache_body(&account_id, &folder, uid, &body);
    cache_contacts(&contacts);
    let body = pgp::maybe_decrypt(&account_id, sender_email.as_deref(), body);
    let body = smime::maybe_process_smime(&account_id, body, &raw);

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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = fetch_raw_message_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();

    let content = extract_attachment(&result?, attachment_index)?;
    cache_attachment(&account_id, &folder, uid, attachment_index, &content);
    Ok(content)
}

// EXAMINE path — no \Seen side effect. Raw RFC 822 bytes are also the .eml format.
#[tauri::command]
pub async fn fetch_message_source(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    use base64::Engine;
    let mut session = login_for_account(&host, port, &account_id).await?;
    let raw = fetch_raw_message_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();
    Ok(base64::engine::general_purpose::STANDARD.encode(raw?))
}

// Same EXAMINE path as fetch_message_source — no \Seen side effect.
#[tauri::command]
pub async fn export_message_eml(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
    path: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let raw = fetch_raw_message_by_uid(&mut session, &folder, uid).await;
    session.logout().await.ok();
    std::fs::write(&path, raw?).map_err(|e| format!("could not write {path}: {e}"))
}

/// Joins a slice of UIDs into an IMAP UID set string (`"3,5,9"`), or
/// `None` when the slice is empty -- a STORE/COPY against an empty set is
/// a caller error, not a no-op to paper over, so the commands below turn
/// `None` into an explicit error rather than silently doing nothing.
fn join_uids(uids: &[u32]) -> Option<String> {
    if uids.is_empty() {
        return None;
    }
    Some(uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(","))
}

/// Adds or removes one flag across a UID set via `UID STORE`. Opens the
/// folder with `SELECT`, not `EXAMINE` -- unlike `fetch_messages`, this is
/// specifically here to mutate mailbox state. `uid_set` is any valid IMAP
/// UID set: a single UID, a comma list, or `1:*` for the whole folder.
async fn set_flag(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    flag: &str,
    set: bool,
) -> Result<(), String> {
    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let sign = if set { "+" } else { "-" };
    session
        .uid_store(uid_set, format!("{sign}FLAGS.SILENT ({flag})"))
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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, &uid.to_string(), "\\Seen", seen).await;
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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, &uid.to_string(), "\\Flagged", flagged).await;
    session.logout().await.ok();
    result
}

/// Sets or clears an arbitrary IMAP keyword flag on a single message.
/// Used for non-system flags like `$Junk`/`$NotJunk` that aren't first-class
/// commands but are recognised by many server-side filters. `pub(crate)` so
/// `account::report_spam` can tag `$Junk` without duplicating the
/// login/logout dance.
pub(crate) async fn set_message_keyword(
    account_id: &str,
    host: &str,
    port: u16,
    folder: &str,
    uid: u32,
    keyword: &str,
    set: bool,
) -> Result<(), String> {
    let mut session = login_for_account(host, port, account_id).await?;
    let result = set_flag(&mut session, folder, &uid.to_string(), keyword, set).await;
    session.logout().await.ok();
    result
}

/// Sets/clears `\Seen` across many messages in one `UID STORE` -- the
/// multi-select "mark as read/unread" action. One round-trip for the whole
/// selection rather than one per message.
#[tauri::command]
pub async fn set_messages_seen(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uids: Vec<u32>,
    seen: bool,
) -> Result<(), String> {
    let uid_set = join_uids(&uids).ok_or("no messages selected")?;
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, &uid_set, "\\Seen", seen).await;
    session.logout().await.ok();
    result
}

/// Sets/clears `\Flagged` across many messages in one `UID STORE` -- the
/// multi-select "star/unstar" action.
#[tauri::command]
pub async fn set_messages_flagged(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uids: Vec<u32>,
    flagged: bool,
) -> Result<(), String> {
    let uid_set = join_uids(&uids).ok_or("no messages selected")?;
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = set_flag(&mut session, &folder, &uid_set, "\\Flagged", flagged).await;
    session.logout().await.ok();
    result
}

/// Marks every message in `folder` `\Seen` (or unseen) in one shot -- the
/// "mark all as read" action. Uses a `1:*` UID store, short-circuiting on
/// an empty folder since a `1:*` store errors on some servers when there's
/// nothing to act on.
#[tauri::command]
pub async fn mark_folder_seen(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    seen: bool,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = async {
        let mailbox = session
            .select(&folder)
            .await
            .map_err(|e| format!("could not open folder {folder}: {e}"))?;
        if mailbox.exists == 0 {
            return Ok(());
        }
        let sign = if seen { "+" } else { "-" };
        session
            .uid_store("1:*", format!("{sign}FLAGS.SILENT (\\Seen)"))
            .await
            .map_err(|e| format!("STORE failed: {e}"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| format!("STORE failed: {e}"))?;
        Ok(())
    }
    .await;
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
    targets: &[u32],
    destination_folder: &str,
) -> Result<(), String> {
    let uid_str = match join_uids(targets) {
        Some(s) => s,
        None => return Ok(()),
    };

    session
        .uid_copy(&uid_str, destination_folder)
        .await
        .map_err(|e| format!("COPY failed: {e}"))?;

    let other_deleted: Vec<u32> = session
        .uid_search("DELETED")
        .await
        .map_err(|e| format!("SEARCH failed: {e}"))?
        .into_iter()
        .filter(|other_uid| !targets.contains(other_uid))
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
async fn move_messages(
    session: &mut ImapSession,
    folder: &str,
    uids: &[u32],
    destination_folder: &str,
) -> Result<(), String> {
    let uid_set = match join_uids(uids) {
        Some(s) => s,
        None => return Ok(()),
    };

    session
        .select(folder)
        .await
        .map_err(|e| format!("could not open folder {folder}: {e}"))?;

    let capabilities = session
        .capabilities()
        .await
        .map_err(|e| format!("CAPABILITY failed: {e}"))?;

    if capabilities.has_str("MOVE") {
        return session
            .uid_mv(&uid_set, destination_folder)
            .await
            .map_err(|e| format!("MOVE failed: {e}"));
    }

    if capabilities.has_str("UIDPLUS") {
        return move_via_copy_store_uid_expunge(session, &uid_set, destination_folder).await;
    }

    move_via_search_store_expunge(session, uids, destination_folder).await
}

/// Runs the move, and when it fails, checks whether the destination folder
/// simply doesn't exist under that name on this server (the configured
/// "Trash" vs the real "INBOX.Trash") -- if an equivalent folder does, the
/// move is retried against it and the corrected name is persisted to the
/// account record so subsequent moves go straight to the right place.
async fn move_messages_with_heal(
    session: &mut ImapSession,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    destination_folder: &str,
) -> Result<(), String> {
    let first_error = match move_messages(session, folder, uids, destination_folder).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let Ok(folders) = collect_folder_names(session).await else {
        return Err(first_error);
    };
    let Some(real_folder) = resolve_equivalent_folder(&folders, destination_folder) else {
        return Err(first_error);
    };
    log::info!("move to {destination_folder:?} failed ({first_error}); retrying against {real_folder:?}");
    move_messages(session, folder, uids, &real_folder).await?;
    persist_folder_correction(account_id, destination_folder, &real_folder);
    Ok(())
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
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = move_messages_with_heal(&mut session, &account_id, &folder, &[uid], &destination_folder).await;
    session.logout().await.ok();
    result
}

/// Moves many messages into `destination_folder` in one operation -- the
/// multi-select "move to folder" / "archive selection" action. Goes
/// through the same three-tier MOVE/UIDPLUS/SEARCH strategy as the
/// single-message command, just with a UID set instead of one UID.
#[tauri::command]
pub async fn move_messages_to_folder(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uids: Vec<u32>,
    destination_folder: String,
) -> Result<(), String> {
    let mut session = login_for_account(&host, port, &account_id).await?;
    let result = move_messages_with_heal(&mut session, &account_id, &folder, &uids, &destination_folder).await;
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

    #[test]
    fn resolve_special_folder_handles_nested_and_prefixed_names() {
        let cpanel = vec![
            "INBOX".to_string(),
            "INBOX.Archive".to_string(),
            "INBOX.Junk".to_string(),
            "INBOX.Sent".to_string(),
            "INBOX.spam".to_string(),
            "INBOX.Trash".to_string(),
            "INBOX.Drafts".to_string(),
        ];
        assert_eq!(resolve_special_folder(&cpanel, "sent").as_deref(), Some("INBOX.Sent"));
        assert_eq!(resolve_special_folder(&cpanel, "trash").as_deref(), Some("INBOX.Trash"));
        assert_eq!(resolve_special_folder(&cpanel, "archive").as_deref(), Some("INBOX.Archive"));
        assert_eq!(resolve_special_folder(&cpanel, "drafts").as_deref(), Some("INBOX.Drafts"));
        // "spam" outranks "junk" when both exist.
        assert_eq!(resolve_special_folder(&cpanel, "spam").as_deref(), Some("INBOX.spam"));

        let gmail = vec![
            "INBOX".to_string(),
            "[Gmail]/All Mail".to_string(),
            "[Gmail]/Drafts".to_string(),
            "[Gmail]/Sent Mail".to_string(),
            "[Gmail]/Spam".to_string(),
            "[Gmail]/Trash".to_string(),
        ];
        assert_eq!(resolve_special_folder(&gmail, "sent").as_deref(), Some("[Gmail]/Sent Mail"));
        assert_eq!(resolve_special_folder(&gmail, "archive").as_deref(), Some("[Gmail]/All Mail"));

        let flat = vec!["INBOX".to_string(), "Sent".to_string(), "Trash".to_string()];
        assert_eq!(resolve_special_folder(&flat, "sent").as_deref(), Some("Sent"));
        assert_eq!(resolve_special_folder(&flat, "archive"), None);
    }

    #[test]
    fn resolve_equivalent_folder_heals_names_and_respects_existing_ones() {
        let folders = vec![
            "INBOX".to_string(),
            "INBOX.Sent".to_string(),
            "INBOX.Junk".to_string(),
        ];
        // Exists as-is: nothing to heal.
        assert_eq!(resolve_equivalent_folder(&folders, "INBOX.Sent"), None);
        // Leaf-name match.
        assert_eq!(resolve_equivalent_folder(&folders, "Sent").as_deref(), Some("INBOX.Sent"));
        // Role-synonym match: asked for Spam, server only has Junk.
        assert_eq!(resolve_equivalent_folder(&folders, "Spam").as_deref(), Some("INBOX.Junk"));
        // No plausible target.
        assert_eq!(resolve_equivalent_folder(&folders, "Projects"), None);
    }

    #[test]
    fn detect_namespace_prefix_finds_the_inbox_namespace() {
        let cpanel = vec![
            "INBOX".to_string(),
            "INBOX.Sent".to_string(),
            "INBOX.Trash".to_string(),
        ];
        assert_eq!(detect_namespace_prefix(&cpanel).as_deref(), Some("INBOX."));

        let flat = vec!["INBOX".to_string(), "Sent".to_string()];
        assert_eq!(detect_namespace_prefix(&flat), None);

        let empty: Vec<String> = vec!["INBOX".to_string()];
        assert_eq!(detect_namespace_prefix(&empty), None);
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
            is_spam: false,
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

    #[test]
    fn imap_quote_escapes_quotes_and_backslashes() {
        assert_eq!(imap_quote("plain"), "\"plain\"");
        assert_eq!(imap_quote("with \"quotes\""), "\"with \\\"quotes\\\"\"");
        assert_eq!(imap_quote("back\\slash"), "\"back\\\\slash\"");
    }

    #[test]
    fn imap_quote_strips_crlf_so_it_cannot_break_the_command_line() {
        // A CR or LF in the query would otherwise terminate the IMAP
        // command and let the rest be interpreted as a new command.
        assert_eq!(imap_quote("a\r\nLOGOUT"), "\"aLOGOUT\"");
    }

    #[test]
    fn build_search_criteria_produces_a_four_way_or_chain() {
        assert_eq!(
            build_search_criteria("hi"),
            "OR OR OR SUBJECT \"hi\" FROM \"hi\" TO \"hi\" BODY \"hi\""
        );
    }

    #[test]
    fn build_search_criteria_escapes_the_query_in_every_field() {
        // A query containing a quote must stay escaped in all four fields,
        // not just the first -- otherwise one field could break framing.
        let criteria = build_search_criteria("a\"b");
        assert_eq!(criteria.matches("\"a\\\"b\"").count(), 4);
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

        set_flag(&mut session, "INBOX", "1", "\\Seen", true)
            .await
            .expect("setting \\Seen should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(messages[0].seen, "message should be seen after setting the flag");

        set_flag(&mut session, "INBOX", "1", "\\Seen", false)
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

        set_flag(&mut session, "INBOX", "1", "\\Flagged", true)
            .await
            .expect("setting \\Flagged should succeed");
        let messages = fetch_recent_messages(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        assert!(messages[0].flagged, "message should be flagged after setting the flag");

        set_flag(&mut session, "INBOX", "1", "\\Flagged", false)
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

        move_messages(&mut session, "INBOX", &[1], "Archive")
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

        move_via_search_store_expunge(&mut session, &[1], "Archive")
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
