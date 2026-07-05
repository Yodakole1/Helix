use keyring::Entry;
use zeroize::Zeroize;

// Namespaces every credential in the OS keychain so Helix entries don't
// collide with unrelated apps using the same account_id as a username.
// `pub(crate)` so `cache.rs` can namespace the local cache's on-disk
// directory and keychain-stored encryption key under the same identifier.
pub(crate) const SERVICE_NAME: &str = "dev.helix.app";

fn entry_for(account_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_credential(account_id: String, mut secret: String) -> Result<(), String> {
    let result = entry_for(&account_id)
        .and_then(|entry| entry.set_password(&secret).map_err(|e| e.to_string()));
    secret.zeroize();
    result
}

#[tauri::command]
pub fn get_credential(account_id: String) -> Result<String, String> {
    entry_for(&account_id)?
        .get_password()
        .map_err(|e| e.to_string())
}

/// Like `get_credential`, but reports "no such entry" as `Ok(None)` instead
/// of an error, so callers can fall back to another credential without also
/// masking real keychain failures (locked keyring, no Secret Service). Same
/// distinction `cache::get_or_create_cache_key` relies on, and for the same
/// reason: a transient keychain error must never be treated as "missing".
pub(crate) fn get_credential_if_exists(account_id: &str) -> Result<Option<String>, String> {
    match entry_for(account_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_credential(account_id: String) -> Result<(), String> {
    entry_for(&account_id)?
        .delete_credential()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_real_os_keychain() {
        let unique_id = format!(
            "helix-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let account_id = format!("{unique_id}@example.com");
        let account_id = account_id.as_str();

        store_credential(account_id.to_string(), "correct-horse-battery-staple".to_string())
            .expect("store should succeed");

        let secret = get_credential(account_id.to_string()).expect("get should succeed");
        assert_eq!(secret, "correct-horse-battery-staple");

        delete_credential(account_id.to_string()).expect("delete should succeed");

        let result = get_credential(account_id.to_string());
        assert!(result.is_err(), "credential should be gone after delete");
    }
}
