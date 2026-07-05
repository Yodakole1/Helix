//! Optional app lock: a lock screen shown once per app start, cleared by a
//! password, a FIDO2 passkey (YubiKey or similar), or both -- whichever the
//! user has enrolled in Settings. Neither is required; with nothing
//! enrolled the app opens straight to the mailbox as before.
//!
//! The password is never stored -- only an Argon2id hash of it, kept in the
//! OS keychain under a reserved sentinel name (same pattern as the local
//! cache key). The passkey path stores the credential id and public key in
//! the encrypted cache and verifies a fresh assertion (challenge signature)
//! against that key on every unlock.
//!
//! Passkey hardware support is compiled in only with the `passkey` cargo
//! feature (its USB HID stack needs libudev headers on Linux); without it
//! the commands stay callable and return a clear error, so the frontend can
//! explain instead of breaking.

use serde::Serialize;
use zeroize::Zeroize;

use crate::cache;
use crate::credentials;

/// Keychain entry name for the Argon2 hash of the lock password. Reserved
/// the same way cache.rs's `__local_cache_key__` is -- no email address can
/// collide with it.
const LOCK_PASSWORD_ENTRY: &str = "__app_lock_password__";

/// Relying-party id used for the locally-enrolled FIDO2 credential. This is
/// direct CTAP2 (no browser, no server), so the value only has to be stable
/// between enrollment and unlock.
#[cfg(feature = "passkey")]
const LOCK_RP_ID: &str = "helix.app";

#[derive(Debug, Serialize)]
pub struct AppLockConfig {
    pub password_set: bool,
    pub passkey_set: bool,
    /// False when this build was compiled without the `passkey` feature --
    /// the settings UI shows how to enable it instead of a dead button.
    pub passkey_available: bool,
}

// -- password hashing (pure, unit-tested) -----------------------------------

fn hash_lock_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::{rand_core::OsRng, SaltString};
    use argon2::{Argon2, PasswordHasher};

    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("could not hash lock password: {e}"))
}

fn verify_lock_hash(password: &str, hash: &str) -> bool {
    use argon2::{Argon2, PasswordHash, PasswordVerifier};

    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

// -- commands ----------------------------------------------------------------

#[tauri::command]
pub fn get_app_lock_config() -> Result<AppLockConfig, String> {
    let password_set = credentials::get_credential(LOCK_PASSWORD_ENTRY.to_string()).is_ok();
    let passkey_set = cache::open()
        .and_then(|conn| cache::get_app_lock_passkey(&conn))
        .map(|k| k.is_some())
        .unwrap_or(false);
    Ok(AppLockConfig {
        password_set,
        passkey_set,
        passkey_available: cfg!(feature = "passkey"),
    })
}

#[tauri::command]
pub fn set_app_lock_password(mut password: String) -> Result<(), String> {
    if password.len() < 4 {
        password.zeroize();
        return Err("the lock password needs at least 4 characters".to_string());
    }
    let hash = hash_lock_password(&password);
    password.zeroize();
    credentials::store_credential(LOCK_PASSWORD_ENTRY.to_string(), hash?)
}

#[tauri::command]
pub fn clear_app_lock_password() -> Result<(), String> {
    credentials::delete_credential(LOCK_PASSWORD_ENTRY.to_string())
}

#[tauri::command]
pub fn verify_app_lock_password(mut password: String) -> Result<bool, String> {
    let hash = credentials::get_credential(LOCK_PASSWORD_ENTRY.to_string())?;
    let ok = verify_lock_hash(&password, &hash);
    password.zeroize();
    Ok(ok)
}

#[tauri::command]
pub fn clear_app_lock_passkey() -> Result<(), String> {
    let conn = cache::open()?;
    cache::clear_app_lock_passkey(&conn)
}

/// Enrolls the connected FIDO2 key: MakeCredential against the local RP id,
/// verify the attestation, and persist the credential id + public key.
/// `pin` is the security key's own PIN, needed only if the key has one set.
#[cfg(feature = "passkey")]
#[tauri::command]
pub fn register_app_lock_passkey(pin: Option<String>) -> Result<(), String> {
    use ctap_hid_fido2::fidokey::MakeCredentialArgsBuilder;
    use ctap_hid_fido2::{verifier, Cfg, FidoKeyHidFactory};

    let device = FidoKeyHidFactory::create(&Cfg::init())
        .map_err(|e| format!("no FIDO2 security key found: {e}"))?;

    let challenge = verifier::create_challenge();
    let mut builder = MakeCredentialArgsBuilder::new(LOCK_RP_ID, &challenge);
    if let Some(pin) = pin.as_deref() {
        builder = builder.pin(pin);
    }
    let attestation = device
        .make_credential_with_args(&builder.build())
        .map_err(|e| format!("security key enrollment failed: {e}"))?;

    let verify_result = verifier::verify_attestation(LOCK_RP_ID, &challenge, &attestation);
    if !verify_result.is_success {
        return Err("the security key's attestation did not verify".to_string());
    }

    let conn = cache::open()?;
    cache::set_app_lock_passkey(
        &conn,
        &verify_result.credential_id,
        &verify_result.credential_public_key.der,
        LOCK_RP_ID,
    )
}

/// Asks the connected key to sign a fresh challenge with the enrolled
/// credential and verifies the signature against the stored public key.
/// Returns true on a valid assertion (i.e. unlock granted).
#[cfg(feature = "passkey")]
#[tauri::command]
pub fn passkey_unlock(pin: Option<String>) -> Result<bool, String> {
    use ctap_hid_fido2::fidokey::GetAssertionArgsBuilder;
    use ctap_hid_fido2::{verifier, Cfg, FidoKeyHidFactory};

    let conn = cache::open()?;
    let stored = cache::get_app_lock_passkey(&conn)?
        .ok_or_else(|| "no passkey is enrolled".to_string())?;

    let device = FidoKeyHidFactory::create(&Cfg::init())
        .map_err(|e| format!("no FIDO2 security key found: {e}"))?;

    let challenge = verifier::create_challenge();
    let mut builder = GetAssertionArgsBuilder::new(&stored.rp_id, &challenge)
        .credential_id(&stored.credential_id);
    if let Some(pin) = pin.as_deref() {
        builder = builder.pin(pin);
    }
    let assertions = device
        .get_assertion_with_args(&builder.build())
        .map_err(|e| format!("security key assertion failed: {e}"))?;

    let assertion = assertions
        .first()
        .ok_or_else(|| "the security key returned no assertion".to_string())?;
    Ok(verifier::verify_assertion(
        &stored.rp_id,
        &stored.public_key_der,
        &challenge,
        assertion,
    ))
}

#[cfg(not(feature = "passkey"))]
#[tauri::command]
pub fn register_app_lock_passkey(pin: Option<String>) -> Result<(), String> {
    let _ = pin;
    Err("this build has no passkey support -- rebuild with `--features passkey` (needs libudev-dev on Linux)".to_string())
}

#[cfg(not(feature = "passkey"))]
#[tauri::command]
pub fn passkey_unlock(pin: Option<String>) -> Result<bool, String> {
    let _ = pin;
    Err("this build has no passkey support -- rebuild with `--features passkey` (needs libudev-dev on Linux)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_round_trips_and_rejects_wrong_passwords() {
        let hash = hash_lock_password("hunter22").expect("hashing should succeed");
        assert!(hash.starts_with("$argon2"), "should be an argon2 PHC string, got {hash}");
        assert!(verify_lock_hash("hunter22", &hash));
        assert!(!verify_lock_hash("hunter23", &hash));
        assert!(!verify_lock_hash("", &hash));
    }

    #[test]
    fn verify_tolerates_a_malformed_stored_hash() {
        assert!(!verify_lock_hash("anything", "not-a-phc-string"));
    }

    #[test]
    fn two_hashes_of_the_same_password_differ_by_salt() {
        let a = hash_lock_password("same-password").unwrap();
        let b = hash_lock_password("same-password").unwrap();
        assert_ne!(a, b, "salts must differ");
        assert!(verify_lock_hash("same-password", &a));
        assert!(verify_lock_hash("same-password", &b));
    }
}
