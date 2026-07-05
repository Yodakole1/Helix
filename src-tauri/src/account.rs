use chrono::{DateTime, FixedOffset};
use serde::Serialize;
use zeroize::Zeroize;

use crate::cache;
use crate::cache::AccountRecord;
use crate::credentials;
use crate::imap;
use crate::imap::MessageSummary;
use crate::pop3;

#[derive(Debug, Serialize)]
pub struct AddAccountResult {
    pub account_id: String,
    pub folders: Vec<String>,
}

/// Stores the account's password in the OS keychain, verifies it by
/// actually connecting and logging in, then persists the account's
/// connection metadata (host/port/folder names, never the password) to
/// the local encrypted cache -- the same SQLCipher-backed database as
/// cached mail (`cache.rs`), so account metadata gets the same
/// at-rest protection rather than living in a separate plaintext config
/// file. Rolls the stored credential back if either the IMAP check or
/// the persistence step fails: onboarding should never leave a broken,
/// unverified, or unrecorded credential sitting in the keychain.
#[tauri::command]
pub async fn add_account(
    account_id: String,
    password: String,
    display_name: Option<String>,
    imap_host: String,
    imap_port: u16,
    imap_use_starttls: bool,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
    archive_folder: Option<String>,
    trash_folder: Option<String>,
    drafts_folder: Option<String>,
    spam_folder: Option<String>,
    sent_folder: Option<String>,
) -> Result<AddAccountResult, String> {
    credentials::store_credential(account_id.clone(), password)?;

    // Verify with the explicit STARTTLS flag, not `imap::list_folders`
    // (which would resolve the flag from the cache -- but the account isn't
    // persisted yet, so that lookup would always default to implicit TLS).
    let folders = match imap::verify_and_list_folders(&imap_host, imap_port, &account_id, imap_use_starttls).await {
        Ok(folders) => folders,
        Err(e) => {
            credentials::delete_credential(account_id).ok();
            return Err(e);
        }
    };

    // Special folders: an explicit caller override wins, otherwise resolve
    // the real folder from the LIST response we already have -- providers
    // that nest mailboxes ("INBOX.Sent", "[Gmail]/Sent Mail") make the bare
    // defaults name folders that don't exist, which used to silently break
    // save-to-Sent and archive/trash moves on those servers.
    let special = |explicit: Option<String>, role: &str, default: &str| {
        explicit.unwrap_or_else(|| {
            imap::resolve_special_folder(&folders, role).unwrap_or_else(|| default.to_string())
        })
    };

    let record = AccountRecord {
        account_id: account_id.clone(),
        display_name,
        imap_host,
        imap_port,
        imap_use_starttls,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        incoming_protocol: "imap".to_string(),
        pop3_host: None,
        pop3_port: None,
        archive_folder: special(archive_folder, "archive", "Archive"),
        trash_folder: special(trash_folder, "trash", "Trash"),
        drafts_folder: special(drafts_folder, "drafts", "Drafts"),
        spam_folder: special(spam_folder, "spam", "Spam"),
        sent_folder: special(sent_folder, "sent", "Sent"),
    };

    if let Err(e) = cache::open().and_then(|conn| cache::upsert_account(&conn, &record)) {
        credentials::delete_credential(account_id).ok();
        return Err(e);
    }

    Ok(AddAccountResult { account_id, folders })
}

/// Onboards a POP3 account: stores the credential, verifies it with a real
/// POP3 login, then persists the account with `incoming_protocol = "pop3"`.
/// The `imap_*` columns are left as empty placeholders -- POP3 has no
/// folders or IMAP server -- and `pop3_host`/`pop3_port` carry the real
/// incoming server. Same store-verify-persist-or-roll-back discipline as
/// `add_account`: a credential is never left in the keychain unverified or
/// unrecorded.
///
/// SMTP is still configured the same way (a POP3 account sends mail over
/// SMTP like any other). Returns `["INBOX"]` as the folder list -- POP3 is
/// a single, implicit mailbox, so this keeps the result shape identical to
/// `add_account` for the frontend.
#[tauri::command]
pub async fn add_pop3_account(
    account_id: String,
    password: String,
    display_name: Option<String>,
    pop3_host: String,
    pop3_port: u16,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
) -> Result<AddAccountResult, String> {
    credentials::store_credential(account_id.clone(), password)?;

    if let Err(e) = pop3::verify_login(&pop3_host, pop3_port, &account_id).await {
        credentials::delete_credential(account_id).ok();
        return Err(e);
    }

    let record = AccountRecord {
        account_id: account_id.clone(),
        display_name,
        imap_host: String::new(),
        imap_port: 0,
        imap_use_starttls: false,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        incoming_protocol: "pop3".to_string(),
        pop3_host: Some(pop3_host),
        pop3_port: Some(pop3_port),
        archive_folder: "Archive".to_string(),
        trash_folder: "Trash".to_string(),
        drafts_folder: "Drafts".to_string(),
        spam_folder: "Spam".to_string(),
        sent_folder: "Sent".to_string(),
    };

    if let Err(e) = cache::open().and_then(|conn| cache::upsert_account(&conn, &record)) {
        credentials::delete_credential(account_id).ok();
        return Err(e);
    }

    Ok(AddAccountResult { account_id, folders: vec!["INBOX".to_string()] })
}

/// Updates an existing account's settings -- the counterpart that lets a
/// user rotate a password or move to a new server without removing and
/// re-adding the account (which would lose its cached mail and identity).
///
/// `password` is optional: `Some` rotates the keychain credential, `None`
/// leaves it untouched (a host/port-only change). The new connection
/// settings are re-verified before they're committed, and -- crucially --
/// if a rotated password fails verification, the *old* password is restored
/// to the keychain, so a failed update never locks the user out of an
/// account that was working a moment ago.
#[tauri::command]
pub async fn update_account(
    account_id: String,
    password: Option<String>,
    display_name: Option<String>,
    imap_host: String,
    imap_port: u16,
    imap_use_starttls: bool,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
) -> Result<(), String> {
    let conn = cache::open()?;
    let existing = cache::get_account(&conn, &account_id)?
        .ok_or_else(|| format!("no account {account_id} to update"))?;

    // If rotating the password, keep the old one so we can restore it if
    // verification of the new settings fails. Zeroized on every exit path
    // below, success or failure, same convention as `imap::login_with_stored_credential`.
    let mut old_password = if password.is_some() {
        Some(credentials::get_credential(account_id.clone())?)
    } else {
        None
    };
    if let Some(new_password) = password {
        credentials::store_credential(account_id.clone(), new_password)?;
    }

    // Re-verify with the protocol the account actually uses.
    let verify = if existing.incoming_protocol == "pop3" {
        let host = existing.pop3_host.clone().unwrap_or_default();
        let port = existing.pop3_port.unwrap_or(995);
        pop3::verify_login(&host, port, &account_id).await.map(|_| ())
    } else {
        imap::verify_and_list_folders(&imap_host, imap_port, &account_id, imap_use_starttls)
            .await
            .map(|_| ())
    };

    if let Err(e) = verify {
        // Roll the credential back to what was working before, if we changed it.
        if let Some(mut old) = old_password.take() {
            credentials::store_credential(account_id.clone(), old.clone()).ok();
            old.zeroize();
        }
        return Err(e);
    }
    if let Some(mut old) = old_password.take() {
        old.zeroize();
    }

    // Preserve protocol-specific and folder fields; only the connection
    // settings exposed by this command change. A POP3 account keeps its
    // pop3_host/port (this command doesn't expose editing them yet).
    let record = AccountRecord {
        account_id: account_id.clone(),
        display_name,
        imap_host,
        imap_port,
        imap_use_starttls,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        incoming_protocol: existing.incoming_protocol,
        pop3_host: existing.pop3_host,
        pop3_port: existing.pop3_port,
        archive_folder: existing.archive_folder,
        trash_folder: existing.trash_folder,
        drafts_folder: existing.drafts_folder,
        spam_folder: existing.spam_folder,
        sent_folder: existing.sent_folder,
    };
    cache::upsert_account(&conn, &record)
}

#[tauri::command]
pub fn list_accounts() -> Result<Vec<AccountRecord>, String> {
    let conn = cache::open()?;
    cache::list_accounts(&conn)
}

/// Removes a configured account: its keychain credential and its
/// persisted metadata + cached mail. The keychain deletion is the part
/// that matters most -- it's the actual secret -- so it's checked and
/// propagated; cache cleanup failing is logged and not treated as a
/// command failure, the same log-and-continue posture used for cache
/// writes in `imap.rs`.
#[tauri::command]
pub fn remove_account(account_id: String) -> Result<(), String> {
    credentials::delete_credential(account_id.clone())?;

    let result = cache::open().and_then(|conn| cache::delete_account(&conn, &account_id));
    if let Err(e) = result {
        log::warn!("could not remove cached data for {account_id}: {e}");
    }

    Ok(())
}

/// Moves a message to the account's configured `spam_folder` and tags it
/// with the IMAP `$Junk` keyword, so a server-side Bayesian filter (if the
/// server has one) learns from the move. The `$Junk` flag is best-effort:
/// many servers don't act on it, but it costs nothing to set. If the
/// `spam_folder` doesn't exist the move fails with a clear error rather than
/// silently discarding the message.
#[tauri::command]
pub async fn report_spam(
    account_id: String,
    host: String,
    port: u16,
    folder: String,
    uid: u32,
) -> Result<(), String> {
    let conn = cache::open()?;
    let account = cache::get_account(&conn, &account_id)?
        .ok_or_else(|| format!("no account {account_id} in local cache"))?;

    // Tag $Junk first (best-effort; not all servers support it).
    if let Err(e) = imap::set_message_keyword(&account_id, &host, port, &folder, uid, "$Junk", true).await {
        log::warn!("could not set $Junk on message {uid}: {e}");
    }

    // Move to spam folder.
    imap::move_message_to_folder(account_id, host, port, folder, uid, account.spam_folder).await
}

/// One row of a unified, cross-account inbox view -- a `MessageSummary`
/// tagged with which account it came from, since the caller has no other
/// way to tell two same-shaped summaries from different accounts apart.
/// `#[serde(flatten)]` keeps the wire shape a flat object (`account_id`
/// alongside `subject`/`from`/... ) rather than a nested `summary` field.
#[derive(Debug, Serialize)]
pub struct UnifiedMessageSummary {
    pub account_id: String,
    #[serde(flatten)]
    pub summary: MessageSummary,
}

fn parsed_date(date: &Option<String>) -> Option<DateTime<FixedOffset>> {
    date.as_deref().and_then(|d| DateTime::parse_from_rfc3339(d).ok())
}

/// Adapts a POP3 summary to the unified view's `MessageSummary` shape. POP3
/// has no flags/`\Seen` (both default false) and no IMAP UID -- the POP3
/// message `number` is carried in `uid` so the frontend can RETR it via
/// `pop3::fetch_message`, disambiguated from a real IMAP UID by the row's
/// `account_id` (whose `incoming_protocol` the frontend already knows).
fn pop3_summary_to_message_summary(summary: pop3::Pop3MessageSummary) -> MessageSummary {
    MessageSummary {
        uid: Some(summary.number),
        subject: summary.subject,
        from: summary.from,
        date: summary.date,
        seen: false,
        flagged: false,
        message_id: None,
        in_reply_to: None,
        is_spam: false,
    }
}

/// Merges already-fetched per-account summaries into one newest-first
/// list, capped at `limit` overall. Pure and synchronous on purpose --
/// the network fan-out lives in `fetch_unified_inbox`, this is just the
/// merge/sort/truncate logic, so it can be tested without a real IMAP
/// connection.
///
/// Dates are parsed with `DateTime::parse_from_rfc3339` rather than
/// compared as raw strings: `MessageSummary.date` preserves each
/// message's original UTC offset rather than normalizing it, so accounts
/// on servers in different timezones would otherwise sort incorrectly
/// under a plain string comparison. Messages with a missing or
/// unparseable date sort last, not interleaved by accident.
fn merge_and_sort_summaries(
    per_account: Vec<(String, Vec<MessageSummary>)>,
    limit: u32,
) -> Vec<UnifiedMessageSummary> {
    let mut merged: Vec<UnifiedMessageSummary> = per_account
        .into_iter()
        .flat_map(|(account_id, summaries)| {
            summaries.into_iter().map(move |summary| UnifiedMessageSummary {
                account_id: account_id.clone(),
                summary,
            })
        })
        .collect();

    merged.sort_by(|a, b| match (parsed_date(&a.summary.date), parsed_date(&b.summary.date)) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    merged.truncate(limit as usize);
    merged
}

/// The "unified inbox" view: INBOX from every stored account, fetched in
/// parallel and merged by date. Siloed (single-account) views need
/// nothing new -- they're just `fetch_messages` called directly for one
/// `account_id`, as today.
///
/// Reuses `imap::fetch_messages`/`pop3::list_messages` per account rather
/// than a separate path, so the unified view goes through the exact same
/// cache write-through every other fetch does. One account failing (bad
/// password, unreachable server) is logged and skipped, not allowed to
/// blank out every other account's messages.
///
/// IMAP and POP3 accounts are both fanned out, each over its own protocol,
/// and merged by date into one list -- so the unified inbox is genuinely
/// unified rather than IMAP-only. (POP3 has no `EXAMINE` window, so its fan-
/// out lists the whole inbox and the overall `limit` is applied in the
/// merge; for a very large POP3 mailbox that's a real header scan, the cost
/// of POP3 having no server-side fetch window.)
#[tauri::command]
pub async fn fetch_unified_inbox(limit: u32) -> Result<Vec<UnifiedMessageSummary>, String> {
    let accounts = list_accounts()?;

    let fetches = accounts.into_iter().map(|account| async move {
        let result = if account.incoming_protocol == "pop3" {
            let host = account.pop3_host.clone().unwrap_or_default();
            let port = account.pop3_port.unwrap_or(995);
            pop3::list_messages(account.account_id.clone(), host, port)
                .await
                .map(|summaries| summaries.into_iter().map(pop3_summary_to_message_summary).collect())
        } else {
            imap::fetch_messages(
                account.account_id.clone(),
                account.imap_host,
                account.imap_port,
                "INBOX".to_string(),
                limit,
            )
            .await
        };
        (account.account_id, result)
    });

    let per_account: Vec<(String, Vec<MessageSummary>)> = futures::future::join_all(fetches)
        .await
        .into_iter()
        .filter_map(|(account_id, result)| match result {
            Ok(summaries) => Some((account_id, summaries)),
            Err(e) => {
                log::warn!("could not fetch unified inbox messages for {account_id}: {e}");
                None
            }
        })
        .collect();

    Ok(merge_and_sort_summaries(per_account, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires network access to a real IMAP server"]
    async fn rolls_back_the_stored_credential_when_verification_fails() {
        let account_id = "helix-test-add-account@gmail.com";

        let result = add_account(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
            None,
            "imap.gmail.com".to_string(),
            993,
            false,
            "smtp.gmail.com".to_string(),
            465,
            false,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        let err = result.expect_err("login should fail without real credentials");
        assert!(
            err.starts_with("login failed"),
            "expected an IMAP login failure, got: {err}"
        );

        let leftover = credentials::get_credential(account_id.to_string());
        assert!(
            leftover.is_err(),
            "the credential should have been rolled back after the failed verification"
        );
    }

    fn summary_at(uid: u32, date: Option<&str>) -> MessageSummary {
        MessageSummary {
            uid: Some(uid),
            subject: Some(format!("Subject {uid}")),
            from: Some("sender@helix.test".to_string()),
            date: date.map(|d| d.to_string()),
            seen: false,
            flagged: false,
            message_id: None,
            in_reply_to: None,
            is_spam: false,
        }
    }

    #[test]
    fn pop3_summary_converts_with_number_as_uid_and_no_flags() {
        let summary = pop3::Pop3MessageSummary {
            number: 7,
            size: 2048,
            uidl: Some("abc123".to_string()),
            subject: Some("Hello".to_string()),
            from: Some("sender@helix.test".to_string()),
            date: Some("2026-06-20T08:00:00+00:00".to_string()),
        };

        let converted = pop3_summary_to_message_summary(summary);

        assert_eq!(converted.uid, Some(7), "the POP3 number is carried in uid for RETR");
        assert_eq!(converted.subject.as_deref(), Some("Hello"));
        assert!(!converted.seen, "POP3 has no \\Seen");
        assert!(!converted.flagged, "POP3 has no flags");
    }

    #[test]
    fn merges_and_sorts_summaries_from_multiple_accounts_newest_first() {
        let per_account = vec![
            (
                "work@helix.test".to_string(),
                vec![summary_at(1, Some("2026-06-20T08:00:00+00:00"))],
            ),
            (
                "personal@helix.test".to_string(),
                vec![summary_at(2, Some("2026-06-20T10:00:00+00:00"))],
            ),
        ];

        let merged = merge_and_sort_summaries(per_account, 10);

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].account_id, "personal@helix.test", "the later message should sort first");
        assert_eq!(merged[1].account_id, "work@helix.test");
    }

    #[test]
    fn sorts_correctly_across_different_utc_offsets() {
        // 09:30 UTC+1 is earlier than 09:00 UTC -- a plain string
        // comparison would get this backwards (lexicographically "09:30"
        // > "09:00" even though +01:00 means it happened first).
        let per_account = vec![
            ("a@helix.test".to_string(), vec![summary_at(1, Some("2026-06-20T09:30:00+01:00"))]),
            ("b@helix.test".to_string(), vec![summary_at(2, Some("2026-06-20T09:00:00+00:00"))]),
        ];

        let merged = merge_and_sort_summaries(per_account, 10);

        assert_eq!(merged[0].account_id, "b@helix.test", "09:00 UTC is later than 08:30 UTC");
    }

    #[test]
    fn messages_with_no_parseable_date_sort_last_and_limit_is_enforced() {
        let per_account = vec![(
            "a@helix.test".to_string(),
            vec![
                summary_at(1, None),
                summary_at(2, Some("2026-06-20T08:00:00+00:00")),
                summary_at(3, Some("2026-06-20T09:00:00+00:00")),
            ],
        )];

        let merged = merge_and_sort_summaries(per_account, 2);

        assert_eq!(merged.len(), 2, "the overall limit must be enforced after merging");
        assert_eq!(merged[0].summary.uid, Some(3), "newest dated message first");
        assert_eq!(merged[1].summary.uid, Some(2));
    }
}
