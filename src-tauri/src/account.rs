use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::cache;
use crate::cache::AccountRecord;
use crate::credentials;
use crate::imap;
use crate::imap::MessageSummary;

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
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
    archive_folder: Option<String>,
    trash_folder: Option<String>,
    drafts_folder: Option<String>,
) -> Result<AddAccountResult, String> {
    credentials::store_credential(account_id.clone(), password)?;

    let folders = match imap::list_folders(account_id.clone(), imap_host.clone(), imap_port).await {
        Ok(folders) => folders,
        Err(e) => {
            credentials::delete_credential(account_id).ok();
            return Err(e);
        }
    };

    let record = AccountRecord {
        account_id: account_id.clone(),
        display_name,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        smtp_use_starttls,
        archive_folder: archive_folder.unwrap_or_else(|| "Archive".to_string()),
        trash_folder: trash_folder.unwrap_or_else(|| "Trash".to_string()),
        drafts_folder: drafts_folder.unwrap_or_else(|| "Drafts".to_string()),
    };

    if let Err(e) = cache::open().and_then(|conn| cache::upsert_account(&conn, &record)) {
        credentials::delete_credential(account_id).ok();
        return Err(e);
    }

    Ok(AddAccountResult { account_id, folders })
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
/// Reuses `imap::fetch_messages` per account rather than a separate IMAP
/// path, so the unified view goes through the exact same cache
/// write-through every other fetch does. One account failing (bad
/// password, unreachable server) is logged and skipped, not allowed to
/// blank out every other account's messages.
#[tauri::command]
pub async fn fetch_unified_inbox(limit: u32) -> Result<Vec<UnifiedMessageSummary>, String> {
    let accounts = list_accounts()?;

    let fetches = accounts.into_iter().map(|account| async move {
        let result = imap::fetch_messages(
            account.account_id.clone(),
            account.imap_host,
            account.imap_port,
            "INBOX".to_string(),
            limit,
        )
        .await;
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
            "smtp.gmail.com".to_string(),
            465,
            false,
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
        }
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
