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

/// Builds a minimal but valid RFC 2822 message from draft fields, suitable
/// for IMAP APPEND. Uses manual construction rather than lettre so that a
/// missing or incomplete To address (which is normal while composing) doesn't
/// block the save. The result is only ever stored on the server, never sent.
fn build_raw_draft_bytes(
    from: &str,
    to: Option<&str>,
    subject: Option<&str>,
    body_text: Option<&str>,
    in_reply_to: Option<&str>,
    references: &[String],
) -> Vec<u8> {
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S +0000");
    let mut lines = Vec::new();
    lines.push(format!("From: {from}"));
    if let Some(to) = to.filter(|t| !t.trim().is_empty()) {
        lines.push(format!("To: {to}"));
    }
    lines.push(format!("Subject: {}", subject.unwrap_or("")));
    lines.push(format!("Date: {date}"));
    lines.push("MIME-Version: 1.0".to_string());
    lines.push("Content-Type: text/plain; charset=utf-8".to_string());
    if let Some(irt) = in_reply_to {
        lines.push(format!("In-Reply-To: <{irt}>"));
    }
    if !references.is_empty() {
        let refs_str = references.iter().map(|r| format!("<{r}>")).collect::<Vec<_>>().join(" ");
        lines.push(format!("References: {refs_str}"));
    }
    lines.push(String::new()); // blank line separating headers from body
    lines.push(body_text.unwrap_or("").to_string());
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
    let raw_bytes = build_raw_draft_bytes(
        account_id,
        draft.to_addr.as_deref(),
        draft.subject.as_deref(),
        draft.body_text.as_deref(),
        draft.in_reply_to.as_deref(),
        &draft.references,
    );

    let mut session = imap::login_with_stored_credential(host, port, account_id).await?;

    // If there's a previously APPENDed copy of this draft on the server,
    // delete it before appending the updated version so we don't accumulate
    // stale copies in the Drafts folder.
    if let Some(uid) = draft.imap_uid {
        if let Err(e) = delete_imap_draft_uid(&mut session, drafts_folder, uid).await {
            log::warn!("could not remove old draft copy (UID {uid}): {e}");
        }
    }

    session
        .append(drafts_folder, Some("(\\Draft \\Seen)"), None, &raw_bytes)
        .await
        .map_err(|e| format!("APPEND to {drafts_folder} failed: {e}"))?;

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
) -> Result<String, String> {
    let draft_id = draft_id.unwrap_or_else(generate_id);
    let conn = cache::open()?;

    // Preserve any existing imap_uid so append_draft_to_imap can delete the
    // stale server copy before writing the updated one.
    let existing_uid = cache::get_draft(&conn, &draft_id)?.and_then(|d| d.imap_uid);

    let draft = DraftRecord {
        draft_id: draft_id.clone(),
        account_id: account_id.clone(),
        to_addr: to,
        subject,
        body_text,
        body_html,
        in_reply_to,
        references,
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
pub fn list_drafts(account_id: String) -> Result<Vec<DraftSummary>, String> {
    let conn = cache::open()?;
    cache::list_drafts(&conn, &account_id)
}

#[tauri::command]
pub fn get_draft(draft_id: String) -> Result<Option<DraftRecord>, String> {
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
            let mut session = imap::login_with_stored_credential(&imap_host, imap_port, &account_id).await?;
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

/// Queues a message for sending and immediately attempts to deliver it.
/// On failure (offline, transient SMTP error) the message stays in the
/// outbox; the frontend should call `flush_outbox` on reconnect.
#[tauri::command]
pub async fn queue_for_send(
    account_id: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
    to: String,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    attachments: Vec<smtp::OutgoingAttachment>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    encrypt: bool,
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
        },
    )?;

    let send_result = smtp::send_message(
        account_id,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        to,
        subject,
        body_text,
        body_html,
        attachments,
        in_reply_to,
        references,
        encrypt,
    )
    .await;

    match send_result {
        Ok(()) => {
            cache::delete_outbox_item(&conn, &outbox_id)?;
            Ok(QueueResult { sent: true, outbox_id: None })
        }
        Err(e) => {
            log::warn!("immediate send failed, message queued as {outbox_id}: {e}");
            cache::mark_outbox_attempt(&conn, &outbox_id, &e)?;
            Ok(QueueResult { sent: false, outbox_id: Some(outbox_id) })
        }
    }
}

#[tauri::command]
pub fn list_outbox(account_id: String) -> Result<Vec<OutboxRecord>, String> {
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

    let mut sent = 0u32;
    let mut failed = 0u32;

    for item in items {
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
            item.subject.clone(),
            item.body_text.clone(),
            item.body_html.clone(),
            attachments,
            item.in_reply_to.clone(),
            item.references.clone(),
            item.encrypt,
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
