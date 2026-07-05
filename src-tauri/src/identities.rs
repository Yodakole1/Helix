use serde::Serialize;
use crate::cache::{self, IdentityRecord};

#[derive(Debug, Serialize)]
pub struct IdentitySummary {
    pub account_id: String,
    pub address: String,
    pub display_name: Option<String>,
    pub signature: Option<String>,
}

/// Adds or updates a send-as identity for an account. The `address` is the
/// From address that will appear in the message; authentication still uses
/// the account's stored credential. Idempotent: re-adding the same address
/// updates `display_name` and `signature` in place.
#[tauri::command]
pub fn add_identity(
    account_id: String,
    address: String,
    display_name: Option<String>,
    signature: Option<String>,
) -> Result<(), String> {
    let conn = cache::open()?;
    cache::upsert_identity(
        &conn,
        &IdentityRecord {
            account_id,
            address,
            display_name,
            signature,
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    )
}

/// Returns all send-as identities for the given account.
#[tauri::command]
pub fn list_identities(account_id: String) -> Result<Vec<IdentitySummary>, String> {
    let conn = cache::open()?;
    cache::list_identities(&conn, &account_id).map(|records| {
        records
            .into_iter()
            .map(|r| IdentitySummary {
                account_id: r.account_id,
                address: r.address,
                display_name: r.display_name,
                signature: r.signature,
            })
            .collect()
    })
}

/// Removes a send-as identity. Silently succeeds if the address isn't found.
#[tauri::command]
pub fn delete_identity(account_id: String, address: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_identity(&conn, &account_id, &address)
}

/// Mutes a thread so that new arrivals in it are silently marked seen without
/// triggering a notification. `message_id` is the root message's Message-ID
/// header (angle brackets stripped, the same format stored in cache). The mute
/// is account-scoped so muting on one account doesn't affect another.
#[tauri::command]
pub fn mute_thread(account_id: String, message_id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::mute_thread_in(&conn, &account_id, &message_id)
}

/// Removes the mute from a thread. Silently succeeds if the thread wasn't muted.
#[tauri::command]
pub fn unmute_thread(account_id: String, message_id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::unmute_thread_in(&conn, &account_id, &message_id)
}

/// Returns `true` if the thread rooted at `message_id` is currently muted
/// for this account.
#[tauri::command]
pub fn is_thread_muted(account_id: String, message_id: String) -> Result<bool, String> {
    let conn = cache::open()?;
    cache::is_thread_muted(&conn, &account_id, &message_id)
}

/// Returns all muted thread root Message-IDs for an account.
#[tauri::command]
pub fn list_muted_threads(account_id: String) -> Result<Vec<String>, String> {
    let conn = cache::open()?;
    cache::list_muted_threads(&conn, &account_id)
}
