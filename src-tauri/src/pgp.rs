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
pub async fn generate_keypair(account_id: String, name: String) -> Result<PublicKeyInfo, String> {
    // Key generation is seconds of pure CPU -- never run it on the main thread.
    crate::run_blocking(move || generate_keypair_blocking(account_id, name)).await
}

pub(crate) fn generate_keypair_blocking(account_id: String, name: String) -> Result<PublicKeyInfo, String> {
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
pub async fn export_public_key(account_id: String) -> Result<PublicKeyInfo, String> {
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
pub async fn import_own_key(account_id: String, armored_secret_key: String) -> Result<PublicKeyInfo, String> {
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
pub async fn import_contact_key(email: String, armored_public_key: String) -> Result<String, String> {
    let conn = cache::open()?;
    import_contact_key_in(&conn, email, armored_public_key)
}

/// Lists every account's own key (public half only) so the key-management
/// UI can redisplay what's stored after a reload -- without this, the only
/// keys visible are whatever was imported in the current session. The
/// secret half never leaves `cache.rs`, so `StoredOwnKey` carries no
/// secret to hand back.
#[tauri::command]
pub async fn list_own_keys() -> Result<Vec<cache::StoredOwnKey>, String> {
    let conn = cache::open()?;
    cache::list_own_keys(&conn)
}

/// Lists every imported recipient public key, for the same redisplay-
/// after-reload reason as `list_own_keys`.
#[tauri::command]
pub async fn list_contact_keys() -> Result<Vec<cache::StoredContactKey>, String> {
    let conn = cache::open()?;
    cache::list_contact_keys(&conn)
}

/// Forgets an account's own keypair (e.g. to revoke or replace it).
#[tauri::command]
pub async fn delete_own_key(account_id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_own_key(&conn, &account_id)
}

/// Forgets a recipient's imported public key.
#[tauri::command]
pub async fn delete_contact_key(email: String) -> Result<(), String> {
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
    encrypt_and_sign_bytes_in(conn, account_id, recipient_email, plaintext.as_bytes())
}

/// The byte-level core of encrypt-and-sign, shared by the inline path
/// (plain text) and the PGP/MIME path (a serialized MIME entity).
fn encrypt_and_sign_bytes_in(
    conn: &Connection,
    account_id: &str,
    recipient_email: &str,
    content: &[u8],
) -> Result<String, String> {
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
        MessageBuilder::from_bytes("", content.to_vec()).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
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

/// Encrypts and signs an already-serialized MIME entity for the PGP/MIME
/// (RFC 3156) send path in `smtp.rs`.
pub fn encrypt_and_sign_bytes(
    account_id: &str,
    recipient_email: &str,
    content: &[u8],
) -> Result<String, String> {
    let conn = cache::open()?;
    encrypt_and_sign_bytes_in(&conn, account_id, recipient_email, content)
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
// PGP/MIME (RFC 3156) receive path
// ---------------------------------------------------------------------------

/// Pulls the armored payload out of a `multipart/encrypted` message.
/// Returns `None` for anything that isn't one -- including mail that
/// merely *carries* an armored blob (a forwarded .asc attachment must
/// not be treated as this message's encrypted body).
fn extract_pgp_mime_payload(raw_message: &[u8]) -> Option<String> {
    use mail_parser::MimeHeaders;

    let message = mail_parser::MessageParser::default().parse(raw_message)?;

    let content_type = message.content_type()?;
    let is_encrypted = content_type.c_type.eq_ignore_ascii_case("multipart")
        && content_type
            .c_subtype
            .as_ref()
            .map(|s| s.eq_ignore_ascii_case("encrypted"))
            .unwrap_or(false);
    if !is_encrypted {
        return None;
    }

    // RFC 3156 layout: part 1 is application/pgp-encrypted ("Version: 1"),
    // part 2 is application/octet-stream carrying the armor. mail_parser
    // surfaces both as attachments; take the one that actually holds a
    // PGP message rather than trusting part ordering.
    for part in message.attachments() {
        let contents = part.contents();
        if contents
            .windows(ARMOR_HEADER.len())
            .any(|window| window == ARMOR_HEADER.as_bytes())
        {
            return Some(String::from_utf8_lossy(contents).into_owned());
        }
    }
    None
}

/// PGP/MIME counterpart to `maybe_decrypt`: if the raw message is
/// `multipart/encrypted`, decrypt the payload, parse it as the MIME
/// entity it is (RFC 3156 encrypts a complete entity -- possibly
/// multipart with HTML and attachments), and graft its content onto the
/// fetched body. Envelope fields (from/to/subject threading headers)
/// stay from the outer message -- those are the real transported
/// headers. Same best-effort posture as the inline path: any failure
/// returns the body unchanged (still showing the armored attachment)
/// rather than failing the fetch.
pub fn maybe_decrypt_mime(
    account_id: &str,
    sender_email: Option<&str>,
    body: MessageBody,
    raw_message: &[u8],
) -> MessageBody {
    let conn = match cache::open() {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("could not open local cache for PGP/MIME decryption: {e}");
            return body;
        }
    };
    maybe_decrypt_mime_in(&conn, account_id, sender_email, body, raw_message)
}

fn maybe_decrypt_mime_in(
    conn: &Connection,
    account_id: &str,
    sender_email: Option<&str>,
    body: MessageBody,
    raw_message: &[u8],
) -> MessageBody {
    let Some(armored) = extract_pgp_mime_payload(raw_message) else {
        return body;
    };

    let decrypted = match decrypt_and_verify_in(conn, account_id, sender_email, &armored) {
        Ok(decrypted) => decrypted,
        Err(e) => {
            log::warn!("could not decrypt PGP/MIME message for {account_id}: {e}");
            return body;
        }
    };

    match crate::imap::parse_message_body(decrypted.plaintext.as_bytes()) {
        Ok((inner, _sender, _contacts)) => {
            let mut merged = body;
            merged.text = inner.text;
            merged.html = inner.html;
            merged.attachments = inner.attachments;
            merged.pgp_signed_by = decrypted.signed_by;
            merged.pgp_signature_valid = Some(decrypted.signature_valid);
            merged
        }
        Err(e) => {
            log::warn!("decrypted PGP/MIME payload did not parse as MIME: {e}");
            body
        }
    }
}

/// For attachment downloads out of an encrypted message: returns the
/// decrypted inner MIME entity when `raw_message` is a decryptable
/// `multipart/encrypted`, so attachment indexes resolve against what the
/// user actually sees (the decrypted content), not against the armor
/// blob. `None` means "not encrypted (or not decryptable) -- use the raw
/// bytes as-is".
pub fn maybe_decrypt_raw(account_id: &str, raw_message: &[u8]) -> Option<Vec<u8>> {
    let armored = extract_pgp_mime_payload(raw_message)?;
    let conn = cache::open().ok()?;
    match decrypt_and_verify_in(&conn, account_id, None, &armored) {
        Ok(decrypted) => Some(decrypted.plaintext.into_bytes()),
        Err(e) => {
            log::warn!("could not decrypt PGP/MIME message for {account_id}: {e}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Autocrypt (level 1) key harvesting
// ---------------------------------------------------------------------------

/// Opportunistic key discovery from the `Autocrypt:` header (RFC-less,
/// but the de-facto standard Thunderbird/K-9/Delta Chat all emit):
/// `addr=alice@example.com; keydata=<base64 transferable public key>`.
/// Harvested only when the header's `addr` matches the actual From
/// address (an Autocrypt key for someone other than the sender is
/// exactly what a spoofed header would look like) and we don't already
/// have a key for that contact -- a stored key, however it got there,
/// always wins over an unauthenticated header. Best-effort: parse
/// failures are logged, never surfaced.
pub fn harvest_autocrypt(sender_email: Option<&str>, raw_message: &[u8]) {
    let conn = match cache::open() {
        Ok(conn) => conn,
        Err(_) => return,
    };
    harvest_autocrypt_in(&conn, sender_email, raw_message);
}

fn harvest_autocrypt_in(conn: &Connection, sender_email: Option<&str>, raw_message: &[u8]) {
    use base64::Engine;

    let Some(sender) = sender_email else { return };
    let Some(message) = mail_parser::MessageParser::default().parse(raw_message) else {
        return;
    };
    let Some(header) = message.header("Autocrypt").and_then(|v| v.as_text()) else {
        return;
    };

    let mut addr: Option<String> = None;
    let mut keydata: Option<String> = None;
    for attr in header.split(';') {
        let Some((name, value)) = attr.split_once('=') else { continue };
        match name.trim() {
            "addr" => addr = Some(value.trim().to_lowercase()),
            "keydata" => keydata = Some(value.split_whitespace().collect()),
            _ => {}
        }
    }
    let (Some(addr), Some(keydata)) = (addr, keydata) else { return };
    if addr != sender.to_lowercase() {
        log::warn!("ignoring Autocrypt header whose addr ({addr}) is not the sender ({sender})");
        return;
    }

    match cache::get_contact_key(conn, &addr) {
        Ok(Some(_)) => return, // an explicitly stored key always wins
        Ok(None) => {}
        Err(_) => return,
    }

    let result = base64::engine::general_purpose::STANDARD
        .decode(&keydata)
        .map_err(|e| format!("keydata is not valid base64: {e}"))
        .and_then(|bytes| {
            SignedPublicKey::from_bytes(bytes.as_slice())
                .map_err(|e| format!("keydata is not a public key: {e}"))
        })
        .and_then(|key| {
            key.to_armored_string(Default::default())
                .map_err(|e| format!("could not armor key: {e}"))
        })
        .and_then(|armored| import_contact_key_in(&conn, addr.clone(), armored));

    match result {
        Ok(fingerprint) => {
            log::info!("harvested Autocrypt key for {addr} (fingerprint {fingerprint})");
        }
        Err(e) => log::warn!("could not harvest Autocrypt key for {addr}: {e}"),
    }
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

/// Result of an opportunistic WKD lookup (see [`ensure_contact_key_wkd`]).
/// A domain that publishes no key for the address surfaces as `Err`, not a
/// third status, so the caller only has to distinguish "we have a key now"
/// from "we don't".
#[derive(Serialize)]
pub struct WkdEnsureOutcome {
    /// `"already_present"` when a stored key was kept untouched,
    /// `"imported"` when a new one was fetched via WKD and stored.
    pub status: String,
    pub fingerprint: String,
}

/// Opportunistic, unattended key acquisition for the compose/encrypt flow:
/// make sure there is *some* key on file for `email` so an outgoing message
/// can be encrypted -- but never overwrite one that already exists. If a
/// key is already stored (manually imported and verified, or fetched
/// earlier) it is authoritative and returned untouched: whatever a domain's
/// WKD currently serves must not be able to silently replace a key the user
/// has trusted. Only when nothing is stored do we fetch and import.
///
/// This is the no-overwrite counterpart to [`import_contact_key`] (the
/// explicit, deliberately overwrite-capable path behind the key-management
/// UI, where replacing a key is a user's own choice). It mirrors the rule
/// [`harvest_autocrypt`] already applies to Autocrypt headers -- both are
/// acquisitions the user didn't individually confirm, so neither may clobber
/// a user-trusted key.
#[tauri::command]
pub async fn ensure_contact_key_wkd(email: String) -> Result<WkdEnsureOutcome, String> {
    if let Some(existing) = cache::open().and_then(|conn| cache::get_contact_key(&conn, &email))? {
        return Ok(WkdEnsureOutcome {
            status: "already_present".to_string(),
            fingerprint: existing.fingerprint,
        });
    }

    let info = discover_pgp_key_wkd(email.clone()).await?;

    // Re-check after the network round trip: an explicit import that landed
    // in the meantime still wins over this opportunistic fetch.
    let conn = cache::open()?;
    if let Some(existing) = cache::get_contact_key(&conn, &email)? {
        return Ok(WkdEnsureOutcome {
            status: "already_present".to_string(),
            fingerprint: existing.fingerprint,
        });
    }
    let fingerprint = import_contact_key_in(&conn, email, info.public_key)?;
    Ok(WkdEnsureOutcome { status: "imported".to_string(), fingerprint })
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

    /// Builds the outer RFC 3156 message the way `smtp.rs` does, byte for
    /// byte enough for mail_parser: multipart/encrypted wrapping a version
    /// part and the armored payload.
    fn pgp_mime_message(armored: &str) -> Vec<u8> {
        format!(
            "From: Alice <alice@helix.test>\r\n\
             To: Alice <alice@helix.test>\r\n\
             Subject: secret\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"bnd\"\r\n\
             \r\n\
             --bnd\r\n\
             Content-Type: application/pgp-encrypted\r\n\
             \r\n\
             Version: 1\r\n\
             --bnd\r\n\
             Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
             \r\n\
             {armored}\r\n\
             --bnd--\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn pgp_mime_round_trips_a_multipart_body_with_attachment() {
        let conn = temp_connection("pgp-mime-round-trip");
        generate_keypair_in(&conn, "alice@helix.test".to_string(), "Alice".to_string())
            .expect("keygen should succeed");
        let public_key = export_public_key_in(&conn, "alice@helix.test")
            .expect("export should succeed")
            .public_key;
        import_contact_key_in(&conn, "alice@helix.test".to_string(), public_key).expect("import should succeed");

        // The inner entity an encrypted-with-attachments send produces:
        // multipart/mixed with a text part and an attachment.
        let inner = "Content-Type: multipart/mixed; boundary=\"inner\"\r\n\
                     \r\n\
                     --inner\r\n\
                     Content-Type: text/plain; charset=utf-8\r\n\
                     \r\n\
                     the hidden text\r\n\
                     --inner\r\n\
                     Content-Type: application/pdf; name=\"plan.pdf\"\r\n\
                     Content-Disposition: attachment; filename=\"plan.pdf\"\r\n\
                     Content-Transfer-Encoding: base64\r\n\
                     \r\n\
                     JVBERi0xLjQK\r\n\
                     --inner--\r\n";
        let armored = encrypt_and_sign_bytes_in(&conn, "alice@helix.test", "alice@helix.test", inner.as_bytes())
            .expect("encrypt should succeed");

        let raw = pgp_mime_message(&armored);
        let (body, sender, _contacts) =
            crate::imap::parse_message_body(&raw).expect("outer message should parse");

        let decrypted = maybe_decrypt_mime_in(&conn, "alice@helix.test", sender.as_deref(), body, &raw);

        assert_eq!(decrypted.text.as_deref().map(str::trim), Some("the hidden text"));
        assert_eq!(decrypted.attachments.len(), 1);
        assert_eq!(decrypted.attachments[0].filename.as_deref(), Some("plan.pdf"));
        assert_eq!(decrypted.pgp_signed_by.as_deref(), Some("alice@helix.test"));
        assert_eq!(decrypted.pgp_signature_valid, Some(true));
    }

    #[test]
    fn a_forwarded_asc_attachment_is_not_treated_as_pgp_mime() {
        // multipart/mixed carrying an armored blob must come back
        // untouched -- only a real multipart/encrypted may be decrypted.
        let raw: &[u8] = b"From: bob@helix.test\r\n\
            Content-Type: multipart/mixed; boundary=\"b\"\r\n\
            \r\n\
            --b\r\n\
            Content-Type: text/plain\r\n\
            \r\n\
            see attached\r\n\
            --b\r\n\
            Content-Type: application/octet-stream; name=\"old.asc\"\r\n\
            \r\n\
            -----BEGIN PGP MESSAGE-----\r\nabc\r\n-----END PGP MESSAGE-----\r\n\
            --b--\r\n";
        assert!(extract_pgp_mime_payload(raw).is_none());
    }

    #[test]
    fn harvests_an_autocrypt_key_only_from_its_own_sender() {
        use base64::Engine;
        use pgp::ser::Serialize as _;

        let conn = temp_connection("autocrypt-harvest");

        // A real transferable public key to embed: generate one and
        // convert its armor back to raw bytes for the keydata attribute.
        generate_keypair_in(&conn, "carol@helix.test".to_string(), "Carol".to_string())
            .expect("keygen should succeed");
        let armored_public = export_public_key_in(&conn, "carol@helix.test")
            .expect("export should succeed")
            .public_key;
        let (key, _) = SignedPublicKey::from_armor_single(armored_public.as_bytes()).unwrap();
        let keydata = base64::engine::general_purpose::STANDARD.encode(key.to_bytes().unwrap());

        let message = |addr: &str| {
            format!(
                "From: carol@helix.test\r\n\
                 Autocrypt: addr={addr}; keydata={keydata}\r\n\
                 Content-Type: text/plain\r\n\
                 \r\n\
                 hi\r\n"
            )
            .into_bytes()
        };

        // addr that doesn't match the sender: rejected.
        harvest_autocrypt_in(&conn, Some("carol@helix.test"), &message("mallory@helix.test"));
        assert!(cache::get_contact_key(&conn, "mallory@helix.test").unwrap().is_none());
        assert!(cache::get_contact_key(&conn, "carol@helix.test").unwrap().is_none());

        // matching addr: harvested.
        harvest_autocrypt_in(&conn, Some("carol@helix.test"), &message("carol@helix.test"));
        let stored = cache::get_contact_key(&conn, "carol@helix.test").unwrap();
        assert!(stored.is_some(), "the sender's own Autocrypt key should be harvested");
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
