use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, Message, MessageBuilder, SecretKeyParamsBuilder,
    SignedPublicKey, SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::types::{KeyDetails, Password};
use rusqlite::Connection;
use serde::Serialize;

use crate::cache::{self, ContactPgpKey, OwnPgpKey};
use crate::imap::MessageBody;

const ARMOR_HEADER: &str = "-----BEGIN PGP MESSAGE-----";

fn fingerprint_hex(key: &impl KeyDetails) -> String {
    format!("{:x}", key.fingerprint())
}

/// Public information about a keypair, safe to hand back to a caller --
/// unlike `cache::OwnPgpKey`, this never carries the secret key.
#[derive(Debug, Serialize)]
pub struct PublicKeyInfo {
    pub public_key: String,
    pub fingerprint: String,
}

/// Generates a fresh keypair for `account_id`: an Ed25519 primary key
/// (signing + certification) with one Curve25519 ECDH encryption subkey
/// -- the same shape as the `pgp` crate's own `generate_key` example,
/// minus the separate authentication subkey this codebase has no use
/// for. Persists both halves via `cache::upsert_own_key`, unprotected by
/// a separate passphrase (see `pgp.md` for that decision) -- protection
/// is this database's own SQLCipher encryption at rest, same as
/// everything else stored in it.
///
/// Split into a `Connection`-taking core and a thin command wrapper, the
/// same testability split used throughout `imap.rs`/`account.rs` --
/// tests pass a temp-dir connection instead of touching the real cache.
fn generate_keypair_in(conn: &Connection, account_id: String, name: String) -> Result<PublicKeyInfo, String> {
    let user_id = format!("{name} <{account_id}>");

    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519)
        .can_sign(true)
        .primary_user_id(user_id)
        .passphrase(None)
        .subkey(
            SubkeyParamsBuilder::default()
                .key_type(KeyType::ECDH(ECCCurve::Curve25519))
                .can_encrypt(EncryptionCaps::All)
                .passphrase(None)
                .build()
                .map_err(|e| format!("could not configure encryption subkey: {e}"))?,
        );

    let secret_key = params
        .build()
        .map_err(|e| format!("could not configure key: {e}"))?
        .generate(rand::thread_rng())
        .map_err(|e| format!("key generation failed: {e}"))?;
    secret_key
        .verify_bindings()
        .map_err(|e| format!("generated key failed self-verification: {e}"))?;

    let public_key = SignedPublicKey::from(secret_key.clone());
    let fingerprint = fingerprint_hex(&secret_key.primary_key);

    let public_key_armored = public_key
        .to_armored_string(Default::default())
        .map_err(|e| format!("could not armor public key: {e}"))?;
    let secret_key_armored = secret_key
        .to_armored_string(Default::default())
        .map_err(|e| format!("could not armor secret key: {e}"))?;

    cache::upsert_own_key(
        conn,
        &OwnPgpKey {
            account_id,
            public_key: public_key_armored.clone(),
            secret_key: secret_key_armored,
            fingerprint: fingerprint.clone(),
        },
    )?;

    Ok(PublicKeyInfo {
        public_key: public_key_armored,
        fingerprint,
    })
}

#[tauri::command]
pub fn generate_keypair(account_id: String, name: String) -> Result<PublicKeyInfo, String> {
    let conn = cache::open()?;
    generate_keypair_in(&conn, account_id, name)
}

fn export_public_key_in(conn: &Connection, account_id: &str) -> Result<PublicKeyInfo, String> {
    let key = cache::get_own_key(conn, account_id)?.ok_or_else(|| format!("no PGP key on file for {account_id}"))?;
    Ok(PublicKeyInfo {
        public_key: key.public_key,
        fingerprint: key.fingerprint,
    })
}

/// Reads an account's own public key back out, for sharing/backup.
#[tauri::command]
pub fn export_public_key(account_id: String) -> Result<PublicKeyInfo, String> {
    let conn = cache::open()?;
    export_public_key_in(&conn, &account_id)
}

fn import_own_key_in(
    conn: &Connection,
    account_id: String,
    armored_secret_key: String,
) -> Result<PublicKeyInfo, String> {
    let (secret_key, _headers) = SignedSecretKey::from_armor_single(armored_secret_key.as_bytes())
        .map_err(|e| format!("could not parse secret key: {e}"))?;
    secret_key
        .verify_bindings()
        .map_err(|e| format!("key failed self-verification: {e}"))?;

    let public_key = SignedPublicKey::from(secret_key.clone());
    let fingerprint = fingerprint_hex(&secret_key.primary_key);

    let public_key_armored = public_key
        .to_armored_string(Default::default())
        .map_err(|e| format!("could not armor public key: {e}"))?;

    cache::upsert_own_key(
        conn,
        &OwnPgpKey {
            account_id,
            public_key: public_key_armored.clone(),
            secret_key: armored_secret_key,
            fingerprint: fingerprint.clone(),
        },
    )?;

    Ok(PublicKeyInfo {
        public_key: public_key_armored,
        fingerprint,
    })
}

/// Imports an existing identity (e.g. restoring a key generated
/// elsewhere) instead of generating a fresh one. Separate from
/// `import_contact_key` rather than one `import(is_secret: bool)`
/// function -- they touch different tables and mean different things,
/// collapsing them into a boolean flag would just be a trap.
#[tauri::command]
pub fn import_own_key(account_id: String, armored_secret_key: String) -> Result<PublicKeyInfo, String> {
    let conn = cache::open()?;
    import_own_key_in(&conn, account_id, armored_secret_key)
}

fn import_contact_key_in(conn: &Connection, email: String, armored_public_key: String) -> Result<String, String> {
    let (public_key, _headers) = SignedPublicKey::from_armor_single(armored_public_key.as_bytes())
        .map_err(|e| format!("could not parse public key: {e}"))?;
    public_key
        .verify_bindings()
        .map_err(|e| format!("key failed self-verification: {e}"))?;

    let fingerprint = fingerprint_hex(&public_key);

    cache::upsert_contact_key(
        conn,
        &ContactPgpKey {
            email,
            public_key: armored_public_key,
            fingerprint: fingerprint.clone(),
        },
    )?;

    Ok(fingerprint)
}

/// Imports a recipient's public key, keyed by the email the caller
/// associates it with (not necessarily whatever User ID is embedded in
/// the key itself -- the caller knows which contact this key is for).
/// Returns the fingerprint so the caller can show the user something to
/// manually verify against the sender out-of-band, which is the entire
/// point of a fingerprint when there's no keyserver/WKD lookup backing
/// this import.
#[tauri::command]
pub fn import_contact_key(email: String, armored_public_key: String) -> Result<String, String> {
    let conn = cache::open()?;
    import_contact_key_in(&conn, email, armored_public_key)
}

/// Lists every account's own key (public half only) so the key-management
/// UI can redisplay what's stored after a reload -- without this, the only
/// keys visible are whatever was imported in the current session. The
/// secret half never leaves `cache.rs`, so `StoredOwnKey` carries no
/// secret to hand back.
#[tauri::command]
pub fn list_own_keys() -> Result<Vec<cache::StoredOwnKey>, String> {
    let conn = cache::open()?;
    cache::list_own_keys(&conn)
}

/// Lists every imported recipient public key, for the same redisplay-
/// after-reload reason as `list_own_keys`.
#[tauri::command]
pub fn list_contact_keys() -> Result<Vec<cache::StoredContactKey>, String> {
    let conn = cache::open()?;
    cache::list_contact_keys(&conn)
}

/// Forgets an account's own keypair (e.g. to revoke or replace it).
#[tauri::command]
pub fn delete_own_key(account_id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_own_key(&conn, &account_id)
}

/// Forgets a recipient's imported public key.
#[tauri::command]
pub fn delete_contact_key(email: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_contact_key(&conn, &email)
}

fn encryption_subkey(public_key: &SignedPublicKey) -> Result<&pgp::composed::SignedPublicSubKey, String> {
    public_key
        .public_subkeys
        .iter()
        .find(|subkey| subkey.algorithm().can_encrypt())
        .ok_or_else(|| "recipient's key has no encryption-capable subkey".to_string())
}

/// Encrypts `plaintext` to `recipient_email`'s known public key and
/// signs it with `account_id`'s own secret key, producing one
/// ASCII-armored inline message (not PGP/MIME -- see `pgp.md` for why).
/// Returns a clear error rather than ever falling back to plaintext if
/// either key is missing: encryption that silently doesn't happen is the
/// one failure mode this must never produce quietly.
fn encrypt_and_sign_in(conn: &Connection, account_id: &str, recipient_email: &str, plaintext: &str) -> Result<String, String> {
    let own_key = cache::get_own_key(conn, account_id)?
        .ok_or_else(|| format!("no PGP key on file for {account_id}, cannot sign"))?;
    let recipient_key = cache::get_contact_key(conn, recipient_email)?
        .ok_or_else(|| format!("no PGP public key on file for {recipient_email}, cannot encrypt"))?;

    let (secret_key, _) = SignedSecretKey::from_armor_single(own_key.secret_key.as_bytes())
        .map_err(|e| format!("could not parse stored secret key: {e}"))?;
    let (public_key, _) = SignedPublicKey::from_armor_single(recipient_key.public_key.as_bytes())
        .map_err(|e| format!("could not parse recipient's public key: {e}"))?;
    let recipient_subkey = encryption_subkey(&public_key)?;

    let mut rng = rand::thread_rng();
    let mut builder =
        MessageBuilder::from_bytes("", plaintext.as_bytes().to_vec()).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
    builder
        .sign(&secret_key.primary_key, Password::empty(), HashAlgorithm::Sha256)
        .encrypt_to_key(&mut rng, recipient_subkey)
        .map_err(|e| format!("could not encrypt to recipient key: {e}"))?;

    builder
        .to_armored_string(&mut rng, Default::default())
        .map_err(|e| format!("could not produce encrypted message: {e}"))
}

pub fn encrypt_and_sign(account_id: &str, recipient_email: &str, plaintext: &str) -> Result<String, String> {
    let conn = cache::open()?;
    encrypt_and_sign_in(&conn, account_id, recipient_email, plaintext)
}

/// The result of decrypting and attempting to verify an inline-armored
/// PGP message.
pub struct DecryptedMessage {
    pub plaintext: String,
    pub signed_by: Option<String>,
    pub signature_valid: bool,
}

/// Decrypts an inline-armored PGP message with `account_id`'s own secret
/// key, and verifies its signature against `sender_email`'s known public
/// key if one is on file -- `signed_by`/`signature_valid` stay
/// `None`/`false` when the signer's key isn't known, since there's
/// nothing to verify against.
fn decrypt_and_verify_in(
    conn: &Connection,
    account_id: &str,
    sender_email: Option<&str>,
    armored_text: &str,
) -> Result<DecryptedMessage, String> {
    let own_key = cache::get_own_key(conn, account_id)?
        .ok_or_else(|| format!("no PGP key on file for {account_id}, cannot decrypt"))?;
    let (secret_key, _) = SignedSecretKey::from_armor_single(own_key.secret_key.as_bytes())
        .map_err(|e| format!("could not parse stored secret key: {e}"))?;

    let (message, _) =
        Message::from_armor(armored_text.as_bytes()).map_err(|e| format!("could not parse PGP message: {e}"))?;
    let mut decrypted = message
        .decrypt(&Password::empty(), &secret_key)
        .map_err(|e| format!("decryption failed: {e}"))?;

    let plaintext = decrypted
        .as_data_string()
        .map_err(|e| format!("could not read decrypted content: {e}"))?;

    let sender_key = match sender_email {
        Some(email) => cache::get_contact_key(conn, email)?,
        None => None,
    };
    let (signed_by, signature_valid) = match sender_key {
        Some(key) => {
            let (public_key, _) = SignedPublicKey::from_armor_single(key.public_key.as_bytes())
                .map_err(|e| format!("could not parse sender's public key: {e}"))?;
            let valid = decrypted.verify(&public_key).is_ok();
            (Some(key.email), valid)
        }
        None => (None, false),
    };

    Ok(DecryptedMessage {
        plaintext,
        signed_by,
        signature_valid,
    })
}

fn maybe_decrypt_in(conn: &Connection, account_id: &str, sender_email: Option<&str>, mut body: MessageBody) -> MessageBody {
    let Some(text) = &body.text else { return body };
    if !text.trim_start().starts_with(ARMOR_HEADER) {
        return body;
    }

    match decrypt_and_verify_in(conn, account_id, sender_email, text) {
        Ok(decrypted) => {
            body.text = Some(decrypted.plaintext);
            body.pgp_signed_by = decrypted.signed_by;
            body.pgp_signature_valid = Some(decrypted.signature_valid);
        }
        Err(e) => {
            log::warn!("could not decrypt PGP message for {account_id}: {e}");
        }
    }

    body
}

/// Best-effort post-processing step for a freshly fetched `MessageBody`:
/// if its text looks like an inline-armored PGP message and the account
/// has a key on file, decrypt and verify it in place. Called from
/// `imap::fetch_message_body`/`pop3::fetch_message` after the existing
/// cache/contact steps, exactly the same idiom -- not threaded through
/// `parse_message_body` itself, which stays pure MIME parsing.
/// `sender_email` is `None` when the message had no parseable From
/// address at all; decryption still proceeds, just with no signature to
/// verify against.
///
/// Ordinary mail is untouched (`pgp_signed_by`/`pgp_signature_valid` stay
/// `None`). If decryption is attempted but fails (no key, wrong key,
/// corrupt data), the body is returned unchanged with those fields still
/// `None` rather than failing the whole fetch -- a message that can't be
/// decrypted yet should still show up as itself (still-armored text),
/// not vanish.
pub fn maybe_decrypt(account_id: &str, sender_email: Option<&str>, body: MessageBody) -> MessageBody {
    let conn = match cache::open() {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("could not open local cache to check for PGP decryption: {e}");
            return body;
        }
    };
    maybe_decrypt_in(&conn, account_id, sender_email, body)
}

// ---------------------------------------------------------------------------
// Web Key Directory (WKD) auto-discovery -- RFC 9580 / draft-ietf-openpgp-wks
// ---------------------------------------------------------------------------

/// Fetches a contact's OpenPGP public key via WKD (Web Key Directory) and
/// returns it for the caller to review and import explicitly. Does NOT
/// auto-import -- the frontend calls `import_contact_key` after showing
/// the fingerprint to the user, so there's a clear user-visible action
/// rather than silently writing to the keystore.
///
/// Returns `Err` if WKD is not available for the domain, the key cannot
/// be fetched, or the key cannot be parsed.
///
/// The WKD URL is built using the "direct method": the hash is the first ten
/// bytes of the SHA-1 hash of the lowercased local-part, z-base-32 encoded.
/// Most public mail providers (Proton, Fastmail, many others) publish keys
/// this way; it's the approach with the widest deployment.
#[tauri::command]
pub async fn discover_pgp_key_wkd(email: String) -> Result<PublicKeyInfo, String> {
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| format!("invalid email address: {email}"))?;

    // SHA-1 of the lowercased local-part, take the first 10 bytes.
    use sha1::{Digest, Sha1};
    let hash_bytes = Sha1::digest(local.to_lowercase().as_bytes());
    let hash10 = &hash_bytes[..10];

    // z-base-32 encode: custom alphabet used by the WKD spec.
    let zbase32_alphabet = b"ybndrfg8ejkmcpqxot1uwisza345h769";
    let mut encoded = String::new();
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for &byte in hash10 {
        buf = (buf << 8) | (byte as u32);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            encoded.push(zbase32_alphabet[((buf >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        encoded.push(zbase32_alphabet[((buf << (5 - bits)) & 0x1f) as usize] as char);
    }

    // Fetch from the WKD direct method URL.
    let url = format!(
        "https://{}/.well-known/openpgpkey/hu/{}?l={}",
        domain, encoded, local
    );
    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WKD fetch failed for {email}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "WKD key not found for {email} (HTTP {})",
            response.status()
        ));
    }

    let key_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("could not read WKD response for {email}: {e}"))?;

    // The WKD response is binary (Transferable Public Key format), not armored.
    let key = SignedPublicKey::from_bytes(std::io::Cursor::new(&key_bytes))
        .map_err(|e| format!("could not parse WKD key for {email}: {e}"))?;

    let fingerprint = fingerprint_hex(&key);
    let public_key = key
        .to_armored_string(Default::default())
        .map_err(|e| format!("could not armor WKD key: {e}"))?;

    Ok(PublicKeyInfo { public_key, fingerprint })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::AttachmentInfo;

    /// Same temp-dir-per-test, clean-up-on-drop pattern as
    /// `cache.rs`'s own `TempCachePath` -- a real (if disposable)
    /// SQLCipher-encrypted database, not a mock, same as every other
    /// `cache.rs`-backed test in this codebase.
    struct TempConnection {
        dir: std::path::PathBuf,
        conn: Connection,
    }

    impl std::ops::Deref for TempConnection {
        type Target = Connection;
        fn deref(&self) -> &Connection {
            &self.conn
        }
    }

    impl Drop for TempConnection {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_connection(label: &str) -> TempConnection {
        let unique = format!(
            "helix-pgp-test-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        let conn = cache::open_at(&dir.join("cache.sqlite3"), "ab").expect("open should succeed");
        TempConnection { dir, conn }
    }

    #[test]
    fn round_trips_an_encrypted_and_signed_message_to_self() {
        let conn = temp_connection("round-trip");

        generate_keypair_in(&conn, "alice@helix.test".to_string(), "Alice".to_string())
            .expect("keygen should succeed");
        let public_key = export_public_key_in(&conn, "alice@helix.test")
            .expect("export should succeed")
            .public_key;
        import_contact_key_in(&conn, "alice@helix.test".to_string(), public_key).expect("import should succeed");

        let armored = encrypt_and_sign_in(&conn, "alice@helix.test", "alice@helix.test", "hello, encrypted world")
            .expect("encrypt should succeed");
        assert!(armored.contains("BEGIN PGP MESSAGE"));

        let decrypted = decrypt_and_verify_in(&conn, "alice@helix.test", Some("alice@helix.test"), &armored)
            .expect("decrypt should succeed");

        assert_eq!(decrypted.plaintext, "hello, encrypted world");
        assert_eq!(decrypted.signed_by.as_deref(), Some("alice@helix.test"));
        assert!(decrypted.signature_valid);
    }

    #[test]
    fn decrypting_with_the_wrong_account_key_fails() {
        let conn = temp_connection("wrong-key");

        generate_keypair_in(&conn, "alice@helix.test".to_string(), "Alice".to_string())
            .expect("keygen should succeed");
        generate_keypair_in(&conn, "bob@helix.test".to_string(), "Bob".to_string()).expect("keygen should succeed");

        let alice_public_key = export_public_key_in(&conn, "alice@helix.test")
            .expect("export should succeed")
            .public_key;
        import_contact_key_in(&conn, "alice@helix.test".to_string(), alice_public_key).expect("import should succeed");

        let armored = encrypt_and_sign_in(&conn, "alice@helix.test", "alice@helix.test", "for alice's eyes only")
            .expect("encrypt should succeed");

        let result = decrypt_and_verify_in(&conn, "bob@helix.test", Some("alice@helix.test"), &armored);
        assert!(result.is_err(), "bob's key must not be able to decrypt a message encrypted to alice");
    }

    #[test]
    fn encrypting_to_an_unknown_recipient_fails_clearly() {
        let conn = temp_connection("unknown-recipient");

        generate_keypair_in(&conn, "alice@helix.test".to_string(), "Alice".to_string())
            .expect("keygen should succeed");

        let result = encrypt_and_sign_in(&conn, "alice@helix.test", "nobody-on-file@helix.test", "hello");
        let err = result.expect_err("encrypting to an unknown recipient must fail, not silently send plaintext");
        assert!(err.contains("no PGP public key on file"));
    }

    #[test]
    fn lists_and_deletes_own_and_contact_keys() {
        let conn = temp_connection("list-delete");

        generate_keypair_in(&conn, "alice@helix.test".to_string(), "Alice".to_string())
            .expect("keygen should succeed");
        generate_keypair_in(&conn, "bob@helix.test".to_string(), "Bob".to_string()).expect("keygen should succeed");

        let own = cache::list_own_keys(&conn).expect("list own keys should succeed");
        assert_eq!(own.len(), 2, "both generated identities should be listed");
        // The listing must never expose the secret half -- StoredOwnKey has
        // no field for it, this asserts the public half is what's returned.
        assert!(own.iter().all(|k| k.public_key.contains("BEGIN PGP PUBLIC KEY")));

        let alice_public_key = export_public_key_in(&conn, "alice@helix.test")
            .expect("export should succeed")
            .public_key;
        import_contact_key_in(&conn, "Alice@Helix.test".to_string(), alice_public_key).expect("import should succeed");

        let contacts = cache::list_contact_keys(&conn).expect("list contact keys should succeed");
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].email, "alice@helix.test", "email should be stored lowercased");

        cache::delete_own_key(&conn, "alice@helix.test").expect("delete own key should succeed");
        assert_eq!(cache::list_own_keys(&conn).unwrap().len(), 1, "alice's key should be gone");
        assert!(
            cache::get_own_key(&conn, "alice@helix.test").unwrap().is_none(),
            "deleted own key must not be retrievable"
        );

        // Delete is keyed case-insensitively, same as import/lookup.
        cache::delete_contact_key(&conn, "ALICE@helix.test").expect("delete contact key should succeed");
        assert!(cache::list_contact_keys(&conn).unwrap().is_empty(), "alice's contact key should be gone");

        // Deleting something already absent is a no-op success, not an error.
        cache::delete_own_key(&conn, "nobody@helix.test").expect("deleting absent own key should be ok");
        cache::delete_contact_key(&conn, "nobody@helix.test").expect("deleting absent contact key should be ok");
    }

    #[test]
    fn maybe_decrypt_leaves_ordinary_mail_untouched() {
        let conn = temp_connection("ordinary-mail");

        let body = MessageBody {
            text: Some("just a normal message".to_string()),
            html: None,
            attachments: Vec::<AttachmentInfo>::new(),
            pgp_signed_by: None,
            pgp_signature_valid: None,
            smime_signed: false,
            smime_verified: None,
            smime_encrypted: false,
            smime_signer_email: None,
            from: None,
            to: Vec::new(),
            cc: Vec::new(),
            reply_to: None,
            message_id: None,
            in_reply_to: None,
            references: Vec::new(),
            disposition_notification_to: None,
        };

        let result = maybe_decrypt_in(&conn, "alice@helix.test", Some("someone@helix.test"), body);

        assert_eq!(result.text.as_deref(), Some("just a normal message"));
        assert_eq!(result.pgp_signed_by, None);
        assert_eq!(result.pgp_signature_valid, None);
    }
}
