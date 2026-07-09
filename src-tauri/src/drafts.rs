use serde::Serialize;

use crate::cache::{self, DraftRecord, DraftSummary, OutboxRecord};
use crate::imap;
use crate::smtp;

fn generate_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Strips CR/LF from a value that's about to be interpolated into a raw
/// header line below -- unlike smtp.rs's lettre-built attachments, this
/// message is hand-assembled, so an embedded CR/LF in a From/To/Subject/
/// In-Reply-To/References/filename/content-type (several of which a remote
/// sender controls on a reply or forward) would otherwise inject extra
/// header lines into the draft.
fn strip_crlf(value: &str) -> String {
    value.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

/// Wraps a base64 string to 76-character lines per RFC 2045 -- some stricter
/// MIME parsers balk at unbounded single-line base64. The input is already
/// base64 (the frontend supplies attachment bytes pre-encoded), so this only
/// re-flows it onto multiple lines, never re-encodes.
fn wrap_base64(b64: &str) -> String {
    b64.as_bytes()
        .chunks(76)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Builds a minimal but valid RFC 2822 message from draft fields, suitable
/// for IMAP APPEND. Uses manual construction rather than lettre so that a
/// missing or incomplete To address (which is normal while composing) doesn't
/// block the save. The result is only ever stored on the server, never sent.
///
/// Body structure mirrors smtp::build_multipart_body:
/// - text only, no attachments → single text/plain part.
/// - text + html, no attachments → multipart/alternative (text then html).
/// - text (+ optional html) + attachments → multipart/mixed wrapping a
///   text/plain or multipart/alternative body part, then attachment parts.
fn build_raw_draft_bytes(
    from: &str,
    to: Option<&str>,
    subject: Option<&str>,
    body_text: Option<&str>,
    body_html: Option<&str>,
    in_reply_to: Option<&str>,
    references: &[String],
    attachments: &[smtp::OutgoingAttachment],
) -> Vec<u8> {
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S +0000");
    let mut lines = Vec::new();
    lines.push(format!("From: {}", strip_crlf(from)));
    if let Some(to) = to.filter(|t| !t.trim().is_empty()) {
        lines.push(format!("To: {}", strip_crlf(to)));
    }
    lines.push(format!("Subject: {}", strip_crlf(subject.unwrap_or(""))));
    lines.push(format!("Date: {date}"));
    lines.push("MIME-Version: 1.0".to_string());
    // In-Reply-To/References echo the original message's Message-ID and
    // References when replying -- values a remote sender controls -- so they
    // get the same CR/LF stripping as To/Subject to keep them from injecting
    // extra header lines into the hand-built draft.
    if let Some(irt) = in_reply_to {
        lines.push(format!("In-Reply-To: <{}>", strip_crlf(irt)));
    }
    if !references.is_empty() {
        let refs_str = references
            .iter()
            .map(|r| format!("<{}>", strip_crlf(r)))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("References: {refs_str}"));
    }

    let has_html = body_html.map(|h| !h.is_empty()).unwrap_or(false);

    // Simplest case: plain text, no HTML, no attachments.
    if !has_html && attachments.is_empty() {
        lines.push("Content-Type: text/plain; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_text.unwrap_or("").to_string());
        return lines.join("\r\n").into_bytes();
    }

    // HTML + no attachments: multipart/alternative.
    if has_html && attachments.is_empty() {
        let alt_boundary = format!("helix-alt-{}", generate_id());
        lines.push(format!("Content-Type: multipart/alternative; boundary=\"{alt_boundary}\""));
        lines.push(String::new());

        lines.push(format!("--{alt_boundary}"));
        lines.push("Content-Type: text/plain; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_text.unwrap_or("").to_string());

        lines.push(format!("--{alt_boundary}"));
        lines.push("Content-Type: text/html; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_html.unwrap_or("").to_string());

        lines.push(format!("--{alt_boundary}--"));
        return lines.join("\r\n").into_bytes();
    }

    // Attachments (with optional HTML): multipart/mixed.
    let mix_boundary = format!("helix-draft-{}", generate_id());
    lines.push(format!("Content-Type: multipart/mixed; boundary=\"{mix_boundary}\""));
    lines.push(String::new());

    if has_html {
        // Body part is itself multipart/alternative.
        let alt_boundary = format!("helix-alt-{}", generate_id());
        lines.push(format!("--{mix_boundary}"));
        lines.push(format!("Content-Type: multipart/alternative; boundary=\"{alt_boundary}\""));
        lines.push(String::new());

        lines.push(format!("--{alt_boundary}"));
        lines.push("Content-Type: text/plain; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_text.unwrap_or("").to_string());

        lines.push(format!("--{alt_boundary}"));
        lines.push("Content-Type: text/html; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_html.unwrap_or("").to_string());

        lines.push(format!("--{alt_boundary}--"));
    } else {
        lines.push(format!("--{mix_boundary}"));
        lines.push("Content-Type: text/plain; charset=utf-8".to_string());
        lines.push(String::new());
        lines.push(body_text.unwrap_or("").to_string());
    }

    for attachment in attachments {
        let content_type = strip_crlf(&attachment.content_type);
        let filename = strip_crlf(&attachment.filename);
        lines.push(format!("--{mix_boundary}"));
        lines.push(format!("Content-Type: {content_type}; name=\"{filename}\""));
        lines.push(format!("Content-Disposition: attachment; filename=\"{filename}\""));
        lines.push("Content-Transfer-Encoding: base64".to_string());
        lines.push(String::new());
        lines.push(wrap_base64(&attachment.content_base64));
    }

    lines.push(format!("--{mix_boundary}--"));
    lines.join("\r\n").into_bytes()
}

/// Appends the draft to the server's Drafts folder. Best-effort: the caller
/// logs and ignores any error returned here. Returns `Some(uid)` if the server
/// reported APPENDUID, `None` otherwise — most servers don't.
async fn append_draft_to_imap(
    host: &str,
    port: u16,
    account_id: &str,
    drafts_folder: &str,
    draft: &DraftRecord,
) -> Result<(), String> {
    let attachments: Vec<smtp::OutgoingAttachment> = match &draft.attachments_json {
        Some(json) => serde_json::from_str(json)
            .map_err(|e| format!("could not deserialize draft attachments: {e}"))?,
        None => Vec::new(),
    };

    let raw_bytes = build_raw_draft_bytes(
        account_id,
        draft.to_addr.as_deref(),
        draft.subject.as_deref(),
        draft.body_text.as_deref(),
        draft.body_html.as_deref(),
        draft.in_reply_to.as_deref(),
        &draft.references,
        &attachments,
    );

    let mut session = imap::login_for_account(host, port, account_id).await?;

    // If there's a previously APPENDed copy of this draft on the server,
    // delete it before appending the updated version so we don't accumulate
    // stale copies in the Drafts folder.
    if let Some(uid) = draft.imap_uid {
        if let Err(e) = delete_imap_draft_uid(&mut session, drafts_folder, uid).await {
            log::warn!("could not remove old draft copy (UID {uid}): {e}");
        }
    }

    let append_result = session
        .append(drafts_folder, Some("(\\Draft \\Seen)"), None, &raw_bytes)
        .await
        .map_err(|e| format!("APPEND to {drafts_folder} failed: {e}"));

    // Same folder-name heal as smtp::append_to_sent: the configured
    // "Drafts" may really be "INBOX.Drafts" on this server -- resolve it
    // from LIST, retry, and persist the correction.
    if let Err(first_error) = append_result {
        let folders = imap::list_folder_names(&mut session)
            .await
            .map_err(|_| first_error.clone())?;
        let real_folder = imap::resolve_equivalent_folder(&folders, drafts_folder)
            .ok_or(first_error)?;
        session
            .append(&real_folder, Some("(\\Draft \\Seen)"), None, &raw_bytes)
            .await
            .map_err(|e| format!("APPEND to {real_folder} failed: {e}"))?;
        imap::persist_folder_correction(account_id, drafts_folder, &real_folder);
    }

    session.logout().await.ok();
    Ok(())
}

async fn delete_imap_draft_uid(
    session: &mut imap::ImapSession,
    drafts_folder: &str,
    uid: u32,
) -> Result<(), String> {
    use futures::TryStreamExt;

    session
        .select(drafts_folder)
        .await
        .map_err(|e| format!("could not open {drafts_folder}: {e}"))?;

    let uid_str = uid.to_string();
    session
        .uid_store(&uid_str, "+FLAGS.SILENT (\\Deleted)")
        .await
        .map_err(|e| format!("STORE \\Deleted failed: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("STORE \\Deleted failed: {e}"))?;

    session
        .uid_expunge(&uid_str)
        .await
        .map_err(|e| format!("EXPUNGE failed: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("EXPUNGE failed: {e}"))?;

    Ok(())
}

/// Saves or updates a draft locally and best-effort APPENDs it to the server's
/// Drafts folder. Returns the stable `draft_id` that the caller should pass
/// back on the next autosave so the same row is updated rather than a new one
/// created.
#[tauri::command]
pub async fn save_draft(
    account_id: String,
    imap_host: String,
    imap_port: u16,
    drafts_folder: String,
    draft_id: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    body_text: Option<String>,
    body_html: Option<String>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    attachments: Vec<smtp::OutgoingAttachment>,
) -> Result<String, String> {
    let draft_id = draft_id.unwrap_or_else(generate_id);
    let conn = cache::open()?;

    // Preserve any existing imap_uid so append_draft_to_imap can delete the
    // stale server copy before writing the updated one.
    let existing_uid = cache::get_draft(&conn, &draft_id)?.and_then(|d| d.imap_uid);

    let attachments_json = if attachments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&attachments).map_err(|e| format!("could not serialize draft attachments: {e}"))?)
    };

    let draft = DraftRecord {
        draft_id: draft_id.clone(),
        account_id: account_id.clone(),
        to_addr: to,
        subject,
        body_text,
        body_html,
        in_reply_to,
        references,
        attachments_json,
        imap_uid: existing_uid,
        saved_at: chrono::Utc::now().to_rfc3339(),
    };

    cache::upsert_draft(&conn, &draft)?;

    if let Err(e) = append_draft_to_imap(&imap_host, imap_port, &account_id, &drafts_folder, &draft).await {
        log::warn!("could not sync draft to IMAP Drafts folder: {e}");
    }

    Ok(draft_id)
}

#[tauri::command]
pub async fn list_drafts(account_id: String) -> Result<Vec<DraftSummary>, String> {
    let conn = cache::open()?;
    cache::list_drafts(&conn, &account_id)
}

#[tauri::command]
pub async fn get_draft(draft_id: String) -> Result<Option<DraftRecord>, String> {
    let conn = cache::open()?;
    cache::get_draft(&conn, &draft_id)
}

#[tauri::command]
pub async fn delete_draft(
    account_id: String,
    imap_host: String,
    imap_port: u16,
    drafts_folder: String,
    draft_id: String,
) -> Result<(), String> {
    let conn = cache::open()?;
    let imap_uid = cache::get_draft(&conn, &draft_id)?
        .and_then(|d| d.imap_uid);

    cache::delete_draft(&conn, &draft_id)?;

    if let Some(uid) = imap_uid {
        if let Err(e) = async {
            let mut session = imap::login_for_account(&imap_host, imap_port, &account_id).await?;
            let result = delete_imap_draft_uid(&mut session, &drafts_folder, uid).await;
            session.logout().await.ok();
            result
        }
        .await
        {
            log::warn!("could not delete draft UID {uid} from IMAP: {e}");
        }
    }

    Ok(())
}

/// Returned by `queue_for_send`. `sent: true` means the message went out
/// immediately and the outbox row was removed. `sent: false` means it's
/// queued; the caller should call `flush_outbox` when connectivity returns.
#[derive(Debug, Serialize)]
pub struct QueueResult {
    pub sent: bool,
    pub outbox_id: Option<String>,
}

/// Queues a message for sending and immediately attempts to deliver it,
/// unless `send_at` is set to a future RFC 3339 timestamp (Send Later /
/// undo-send hold). Returns `outbox_id` whenever the row was created --
/// both on immediate success (so the frontend can offer an undo toast that
/// calls `cancel_queued_send`) and on failure or deferred send (so the row
/// can be identified in the outbox view or cancelled).
#[tauri::command]
pub async fn queue_for_send(
    account_id: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
    to: String,
    cc: String,
    bcc: String,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    attachments: Vec<smtp::OutgoingAttachment>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    encrypt: bool,
    send_at: Option<String>,
    from_override: Option<String>,
) -> Result<QueueResult, String> {
    let outbox_id = generate_id();
    let attachments_json = serde_json::to_string(&attachments)
        .map_err(|e| format!("could not serialize attachments: {e}"))?;

    let conn = cache::open()?;
    cache::insert_outbox_item(
        &conn,
        &OutboxRecord {
            outbox_id: outbox_id.clone(),
            account_id: account_id.clone(),
            to_addr: to.clone(),
            cc: cc.clone(),
            bcc: bcc.clone(),
            subject: subject.clone(),
            body_text: body_text.clone(),
            body_html: body_html.clone(),
            attachments_json: Some(attachments_json),
            in_reply_to: in_reply_to.clone(),
            references: references.clone(),
            encrypt,
            attempt_count: 0,
            last_error: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            send_at: send_at.clone(),
            from_override: from_override.clone(),
        },
    )?;

    // Don't attempt an immediate send if the message is scheduled for later.
    let is_deferred = send_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t > chrono::Utc::now())
        .unwrap_or(false);

    if is_deferred {
        return Ok(QueueResult { sent: false, outbox_id: Some(outbox_id) });
    }

    let send_result = smtp::send_message(
        account_id,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        to,
        cc,
        bcc,
        subject,
        body_text,
        body_html,
        attachments,
        in_reply_to,
        references,
        encrypt,
        from_override,
        None,
        None,
    )
    .await;

    match send_result {
        Ok(()) => {
            cache::delete_outbox_item(&conn, &outbox_id)?;
            Ok(QueueResult { sent: true, outbox_id: Some(outbox_id) })
        }
        Err(e) => {
            log::warn!("immediate send failed, message queued as {outbox_id}: {e}");
            cache::mark_outbox_attempt(&conn, &outbox_id, &e)?;
            Ok(QueueResult { sent: false, outbox_id: Some(outbox_id) })
        }
    }
}

/// Cancels a queued (not yet sent) message. Returns `Ok(true)` if the row
/// was deleted, `Ok(false)` if it was already sent and cleaned up (a normal
/// race condition if the flush timer fired at the same time as the undo).
/// The frontend should call this within the undo-send window, keyed by the
/// `outbox_id` returned by `queue_for_send`.
#[tauri::command]
pub async fn cancel_queued_send(outbox_id: String) -> Result<bool, String> {
    let conn = cache::open()?;
    cache::cancel_outbox_item(&conn, &outbox_id)
}

#[tauri::command]
pub async fn list_outbox(account_id: String) -> Result<Vec<OutboxRecord>, String> {
    let conn = cache::open()?;
    cache::list_outbox(&conn, &account_id)
}

/// Returned by `flush_outbox`.
#[derive(Debug, Serialize)]
pub struct FlushResult {
    pub sent: u32,
    pub failed: u32,
}

/// Attempts to send every queued message for `account_id`. Removes
/// successfully sent messages from the outbox; increments `attempt_count`
/// and records the error for ones that still fail. Call this on app
/// startup or when connectivity is restored.
#[tauri::command]
pub async fn flush_outbox(account_id: String) -> Result<FlushResult, String> {
    let conn = cache::open()?;
    let items = cache::list_outbox(&conn, &account_id)?;

    // Look up this account's SMTP settings from the local cache so the caller
    // doesn't need to pass them on every flush call.
    let accounts = cache::list_accounts(&conn)?;
    let account = accounts
        .iter()
        .find(|a| a.account_id == account_id)
        .ok_or_else(|| format!("account {account_id} not found in local cache"))?;

    let smtp_host = account.smtp_host.clone();
    let smtp_port = account.smtp_port;
    let smtp_use_starttls = account.smtp_use_starttls;

    let now = chrono::Utc::now();
    let mut sent = 0u32;
    let mut failed = 0u32;

    for item in items {
        // Skip messages that are scheduled for a future time (Send Later /
        // undo-send hold). They stay in the outbox until their window passes.
        if let Some(ref ts) = item.send_at {
            if let Ok(t) = chrono::DateTime::parse_from_rfc3339(ts) {
                if t > now {
                    continue;
                }
            }
        }

        let attachments: Vec<smtp::OutgoingAttachment> = match &item.attachments_json {
            Some(json) => serde_json::from_str(json)
                .map_err(|e| format!("could not deserialize attachments for {}: {e}", item.outbox_id))?,
            None => Vec::new(),
        };

        let result = smtp::send_message(
            item.account_id.clone(),
            smtp_host.clone(),
            smtp_port,
            smtp_use_starttls,
            item.to_addr.clone(),
            item.cc.clone(),
            item.bcc.clone(),
            item.subject.clone(),
            item.body_text.clone(),
            item.body_html.clone(),
            attachments,
            item.in_reply_to.clone(),
            item.references.clone(),
            item.encrypt,
            item.from_override.clone(),
            None,
            None,
        )
        .await;

        match result {
            Ok(()) => {
                cache::delete_outbox_item(&conn, &item.outbox_id)?;
                sent += 1;
            }
            Err(e) => {
                log::warn!("could not send queued message {}: {e}", item.outbox_id);
                cache::mark_outbox_attempt(&conn, &item.outbox_id, &e)?;
                failed += 1;
            }
        }
    }

    Ok(FlushResult { sent, failed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::MimeHeaders;

    #[test]
    fn wrap_base64_breaks_long_lines_at_76_without_altering_content() {
        let long = "a".repeat(200);
        let wrapped = wrap_base64(&long);
        for line in wrapped.split("\r\n") {
            assert!(line.len() <= 76, "no wrapped line should exceed 76 chars");
        }
        assert_eq!(wrapped.replace("\r\n", ""), long, "re-flowing must not change the content");
    }

    #[test]
    fn builds_a_plain_text_draft_when_there_are_no_attachments() {
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            Some("you@helix.test"),
            Some("Hi"),
            Some("body"),
            None,
            None,
            &[],
            &[],
        );
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(!text.contains("multipart"), "no html/attachments means no multipart wrapper");
    }

    #[test]
    fn builds_a_multipart_alternative_draft_when_html_is_present() {
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            Some("you@helix.test"),
            Some("Hi"),
            Some("plain text"),
            Some("<p>html text</p>"),
            None,
            &[],
            &[],
        );
        let parsed = mail_parser::MessageParser::default()
            .parse(&raw)
            .expect("html draft should parse");

        assert_eq!(parsed.body_text(0).as_deref(), Some("plain text"), "plain part must survive");
        assert_eq!(parsed.body_html(0).as_deref(), Some("<p>html text</p>"), "html part must survive");

        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("multipart/alternative"), "html draft must be multipart/alternative");
        assert!(!text.contains("multipart/mixed"), "no attachments so no mixed wrapper");
    }

    #[test]
    fn builds_a_multipart_draft_that_round_trips_through_a_parser() {
        use base64::Engine;

        let attachment = smtp::OutgoingAttachment {
            filename: "notes.txt".to_string(),
            content_type: "text/plain".to_string(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(b"file body"),
            content_id: None,
        };
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            None,
            Some("Draft"),
            Some("hello"),
            None,
            None,
            &[],
            std::slice::from_ref(&attachment),
        );

        let parsed = mail_parser::MessageParser::default()
            .parse(&raw)
            .expect("the multipart draft should parse");
        assert_eq!(parsed.body_text(0).as_deref(), Some("hello"));

        let attachments: Vec<_> = parsed.attachments().collect();
        assert_eq!(attachments.len(), 1, "the draft should carry exactly one attachment");
        assert_eq!(attachments[0].attachment_name(), Some("notes.txt"));
        assert_eq!(attachments[0].contents(), b"file body");
    }

    #[test]
    fn builds_html_plus_attachment_draft_with_mixed_wrapping_alternative() {
        use base64::Engine;

        let attachment = smtp::OutgoingAttachment {
            filename: "doc.pdf".to_string(),
            content_type: "application/pdf".to_string(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(b"pdf bytes"),
            content_id: None,
        };
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            None,
            Some("Draft with HTML and file"),
            Some("plain part"),
            Some("<p>html part</p>"),
            None,
            &[],
            std::slice::from_ref(&attachment),
        );

        let parsed = mail_parser::MessageParser::default()
            .parse(&raw)
            .expect("mixed+alternative draft should parse");
        assert_eq!(parsed.body_text(0).as_deref(), Some("plain part"), "plain part survives");
        assert_eq!(parsed.body_html(0).as_deref(), Some("<p>html part</p>"), "html part survives");

        let attachments: Vec<_> = parsed.attachments().collect();
        assert_eq!(attachments.len(), 1, "attachment survives");
        assert_eq!(attachments[0].contents(), b"pdf bytes");

        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("multipart/mixed"));
        assert!(text.contains("multipart/alternative"));
    }

    #[test]
    fn crlf_in_to_subject_and_attachment_fields_cannot_inject_extra_headers() {
        use base64::Engine;

        let attachment = smtp::OutgoingAttachment {
            filename: "evil\r\nX-Injected: yes.txt".to_string(),
            content_type: "text/plain\r\nX-Injected: yes".to_string(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(b"body"),
            content_id: None,
        };
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            Some("victim@helix.test\r\nBcc: attacker@evil.test"),
            Some("Subject\r\nX-Injected: yes"),
            Some("hello"),
            None,
            None,
            &[],
            std::slice::from_ref(&attachment),
        );

        let text = String::from_utf8_lossy(&raw);
        let injected_as_own_line = text
            .split("\r\n")
            .any(|line| line.starts_with("X-Injected") || line.starts_with("Bcc:"));
        assert!(!injected_as_own_line, "CR/LF must be stripped so attacker text can't become its own header line");

        let parsed = mail_parser::MessageParser::default()
            .parse(&raw)
            .expect("sanitized draft should still parse as a single valid message");
        assert!(parsed.header("X-Injected").is_none(), "no X-Injected header should be parseable");
        assert!(parsed.bcc().is_none(), "no Bcc header should be parseable");
    }

    #[test]
    fn crlf_in_reply_headers_cannot_inject_extra_headers() {
        // In-Reply-To and References echo the original message's Message-ID and
        // References on a reply -- values the remote sender controls. A CR/LF in
        // either must not turn attacker text into its own header line.
        let raw = build_raw_draft_bytes(
            "me@helix.test",
            Some("you@helix.test"),
            Some("Re: hi"),
            Some("body"),
            None,
            Some("orig-id@evil.test>\r\nBcc: attacker@evil.test"),
            &["ref-a@evil.test>\r\nX-Injected: yes".to_string()],
            &[],
        );

        let text = String::from_utf8_lossy(&raw);
        let injected_as_own_line = text
            .split("\r\n")
            .any(|line| line.starts_with("X-Injected") || line.starts_with("Bcc:"));
        assert!(!injected_as_own_line, "CR/LF in reply headers must be stripped");

        let parsed = mail_parser::MessageParser::default()
            .parse(&raw)
            .expect("sanitized draft should still parse as a single valid message");
        assert!(parsed.header("X-Injected").is_none(), "no X-Injected header should be parseable");
        assert!(parsed.bcc().is_none(), "no Bcc header should be parseable");
    }
}
