use base64::Engine;
use chrono::Utc;
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkcs12::Pkcs12;
use openssl::pkcs7::{Pkcs7, Pkcs7Flags};
use openssl::pkey::PKey;
use openssl::stack::Stack;
use openssl::symm::Cipher;
use openssl::x509::store::X509StoreBuilder;
use openssl::x509::{X509, X509Ref};
use serde::Serialize;

use crate::cache::{self, SmimeContactCert, SmimeOwnCert};
use crate::imap::MessageBody;

// ── Public return types (no private key material) ─────────────────────────────

#[derive(Debug, Serialize)]
pub struct SmimeOwnCertInfo {
    pub account_id: String,
    pub fingerprint: String,
    pub subject_cn: Option<String>,
    pub not_after: String,
}

#[derive(Debug, Serialize)]
pub struct SmimeContactCertInfo {
    pub email: String,
    pub fingerprint: String,
    pub subject_cn: Option<String>,
    pub not_after: String,
    pub added_at: String,
}

/// Metadata about a cert that hasn't been stored yet — used in the import dialog
/// so the user can see what's inside before confirming.
#[derive(Debug, Serialize)]
pub struct SmimeCertInfo {
    pub fingerprint: String,
    pub subject_cn: Option<String>,
    pub issuer_cn: Option<String>,
    pub not_before: String,
    pub not_after: String,
    pub email_san: Vec<String>,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

struct CertMeta {
    fingerprint: String,
    subject_cn: Option<String>,
    issuer_cn: Option<String>,
    not_before: String,
    not_after: String,
    email_san: Vec<String>,
    /// Primary email: SAN email if present, else emailAddress RDN, else None.
    email: Option<String>,
}

#[allow(deprecated)] // as_utf8() warns about NUL truncation; cert CN/email fields never contain NUL
fn cert_meta(cert: &X509Ref) -> Result<CertMeta, String> {
    let fingerprint = cert
        .digest(MessageDigest::sha256())
        .map_err(|e| e.to_string())?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    let subject_cn = cert
        .subject_name()
        .entries_by_nid(Nid::COMMONNAME)
        .next()
        .and_then(|e| e.data().as_utf8().ok().map(|s| s.to_string()));

    let issuer_cn = cert
        .issuer_name()
        .entries_by_nid(Nid::COMMONNAME)
        .next()
        .and_then(|e| e.data().as_utf8().ok().map(|s| s.to_string()));

    let not_before = cert.not_before().to_string();
    let not_after = cert.not_after().to_string();

    let email_san: Vec<String> = cert
        .subject_alt_names()
        .map(|sans| {
            sans.iter()
                .filter_map(|san| san.email().map(|e| e.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let email = if let Some(san_email) = email_san.first() {
        Some(san_email.clone())
    } else {
        cert.subject_name()
            .entries_by_nid(Nid::PKCS9_EMAILADDRESS)
            .next()
            .and_then(|e| e.data().as_utf8().ok())
            .map(|s| s.to_string())
    };

    Ok(CertMeta { fingerprint, subject_cn, issuer_cn, not_before, not_after, email_san, email })
}

/// Parse a cert that may be either PEM or DER (base64-encoded).
fn parse_cert_pem_or_der(input: &str) -> Result<X509, String> {
    let trimmed = input.trim();
    if trimmed.starts_with("-----BEGIN") {
        X509::from_pem(trimmed.as_bytes()).map_err(|e| format!("could not parse PEM cert: {e}"))
    } else {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(trimmed)
            .map_err(|e| format!("invalid base64: {e}"))?;
        X509::from_der(&bytes).map_err(|e| format!("could not parse DER cert: {e}"))
    }
}

// ── S/MIME detection (scans raw bytes, no crypto) ─────────────────────────────

enum SmimeKind {
    None,
    Signed,
    Encrypted,
}

fn detect_smime(raw: &[u8]) -> SmimeKind {
    // Only scan the header region — the boundary is always in the first few KB.
    let header_region = String::from_utf8_lossy(&raw[..raw.len().min(8192)]);
    let lower = header_region.to_lowercase();

    // OpenSSL ≤ 3.x may output "application/x-pkcs7-mime" instead of the RFC 5751 name.
    let is_pkcs7_mime = lower.contains("application/pkcs7-mime")
        || lower.contains("application/x-pkcs7-mime");
    if is_pkcs7_mime && lower.contains("smime-type=enveloped-data") {
        return SmimeKind::Encrypted;
    }
    let is_pkcs7_sig = lower.contains("application/pkcs7-signature")
        || lower.contains("application/x-pkcs7-signature");
    if lower.contains("multipart/signed") && is_pkcs7_sig {
        return SmimeKind::Signed;
    }
    SmimeKind::None
}

// ── S/MIME MIME output parsing ────────────────────────────────────────────────

/// Splits the output of `Pkcs7::to_smime()` into (Content-Type-value, body-bytes).
/// The caller uses Content-Type as a header on the outgoing part and body-bytes as
/// the raw part body.
fn split_smime_output(smime: &[u8]) -> Result<(String, Vec<u8>), String> {
    let text = String::from_utf8_lossy(smime);

    let body_start = text
        .find("\r\n\r\n")
        .map(|p| p + 4)
        .or_else(|| text.find("\n\n").map(|p| p + 2))
        .ok_or("no header/body separator in S/MIME output")?;

    let headers = &text[..body_start];
    let body = smime[body_start..].to_vec();

    // Parse Content-Type (RFC 2822 header folding: continuation lines start with whitespace).
    let mut content_type = String::new();
    let mut capturing = false;
    for line in headers.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.to_lowercase().starts_with("content-type:") {
            content_type = line["content-type:".len()..].trim().to_string();
            capturing = true;
        } else if capturing && (line.starts_with('\t') || line.starts_with(' ')) {
            content_type.push(' ');
            content_type.push_str(line.trim());
        } else if capturing {
            break;
        }
    }

    if content_type.is_empty() {
        return Err("no Content-Type header in S/MIME output".to_string());
    }

    Ok((content_type, body))
}

// ── pub(crate): outgoing S/MIME ───────────────────────────────────────────────

/// Signs `body_bytes` with the own cert for `account_id`.
/// Returns `(content_type_value, mime_body_bytes)` to inject into the lettre message.
pub(crate) fn sign_body(account_id: &str, body_bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let conn = cache::open()?;
    let own = cache::get_smime_own_cert(&conn, account_id)?
        .ok_or_else(|| format!("no S/MIME certificate for {account_id}"))?;

    let cert = X509::from_der(&own.certificate).map_err(|e| e.to_string())?;
    let pkey = PKey::private_key_from_der(&own.private_key).map_err(|e| e.to_string())?;
    let chain = Stack::new().map_err(|e| e.to_string())?;

    let pkcs7 = Pkcs7::sign(&cert, &pkey, &chain, body_bytes, Pkcs7Flags::STREAM)
        .map_err(|e| format!("S/MIME signing failed: {e}"))?;
    let smime_output = pkcs7
        .to_smime(body_bytes, Pkcs7Flags::STREAM)
        .map_err(|e| format!("S/MIME output failed: {e}"))?;

    split_smime_output(&smime_output)
}

/// Encrypts `body_bytes` to the recipient's cert stored under `to_email`.
/// Returns `(content_type_value, mime_body_bytes)`.
pub(crate) fn encrypt_body(to_email: &str, body_bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let conn = cache::open()?;
    let contact_cert = cache::get_smime_contact_cert(&conn, to_email)?
        .ok_or_else(|| format!("no S/MIME certificate for recipient {to_email}"))?;

    let recipient_cert = X509::from_der(&contact_cert.certificate).map_err(|e| e.to_string())?;
    let mut certs = Stack::new().map_err(|e| e.to_string())?;
    certs.push(recipient_cert).map_err(|e| e.to_string())?;

    let pkcs7 = Pkcs7::encrypt(&certs, body_bytes, Cipher::aes_256_cbc(), Pkcs7Flags::empty())
        .map_err(|e| format!("S/MIME encryption failed: {e}"))?;
    let smime_output = pkcs7
        .to_smime(&[], Pkcs7Flags::empty())
        .map_err(|e| format!("S/MIME output failed: {e}"))?;

    split_smime_output(&smime_output)
}

// ── pub(crate): incoming S/MIME processing ────────────────────────────────────

/// Called after `parse_message_body`+PGP processing. Detects S/MIME
/// structure in the raw bytes, decrypts or verifies, and returns an
/// updated `MessageBody`. Best-effort: failures set the flag fields
/// but never fail the fetch.
pub(crate) fn maybe_process_smime(account_id: &str, mut body: MessageBody, raw: &[u8]) -> MessageBody {
    match detect_smime(raw) {
        SmimeKind::None => body,

        SmimeKind::Encrypted => {
            body.smime_encrypted = true;
            let conn = match cache::open() {
                Ok(c) => c,
                Err(_) => return body,
            };
            let own = match cache::get_smime_own_cert(&conn, account_id) {
                Ok(Some(c)) => c,
                _ => return body, // no key — return with smime_encrypted flag only
            };
            let cert = match X509::from_der(&own.certificate) {
                Ok(c) => c,
                Err(_) => return body,
            };
            let pkey = match PKey::private_key_from_der(&own.private_key) {
                Ok(k) => k,
                Err(_) => return body,
            };
            match Pkcs7::from_smime(raw) {
                Ok((pkcs7, _)) => {
                    match pkcs7.decrypt(&pkey, &cert, Pkcs7Flags::empty()) {
                        Ok(decrypted) => {
                            match crate::imap::parse_message_body(&decrypted) {
                                Ok((mut inner, _, _)) => {
                                    inner.smime_encrypted = true;
                                    inner
                                }
                                Err(e) => {
                                    log::warn!("could not re-parse decrypted S/MIME for {account_id}: {e}");
                                    body
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("S/MIME decryption failed for {account_id}: {e}");
                            body
                        }
                    }
                }
                Err(e) => {
                    log::warn!("could not parse S/MIME encrypted message for {account_id}: {e}");
                    body
                }
            }
        }

        SmimeKind::Signed => {
            body.smime_signed = true;
            let extra = match Stack::new() {
                Ok(s) => s,
                Err(_) => return body,
            };
            // Load system CAs so chain validation is real. Without this the
            // store is empty and every cert would fail, which is why the old
            // code used NOVERIFY — but NOVERIFY makes the "verified" flag
            // meaningless (any self-signed cert claiming any address passes).
            let store = match X509StoreBuilder::new() {
                Ok(mut b) => {
                    b.set_default_paths().ok(); // best-effort; proceeds without system CAs on failure
                    b.build()
                }
                Err(_) => return body,
            };
            match Pkcs7::from_smime(raw) {
                Ok((pkcs7, _)) => {
                    let verified = pkcs7
                        .verify(&extra, &store, None, None, Pkcs7Flags::empty())
                        .is_ok();
                    body.smime_verified = Some(verified);

                    if verified {
                        if let Ok(signers) = pkcs7.signers(&extra, Pkcs7Flags::empty()) {
                            if let Some(signer) = signers.iter().next() {
                                if let Ok(meta) = cert_meta(signer) {
                                    body.smime_signer_email = meta.email;
                                }
                            }
                        }
                        // Signer cert is NOT auto-imported: auto-importing keyed by
                        // the email claimed in the cert is a key-substitution vector
                        // (attacker sends a signed email with a cert claiming
                        // ceo@company.com → silently replaces the encryption key for
                        // that address). Import is explicit via import_contact_smime_cert.
                    }
                    body
                }
                Err(e) => {
                    log::warn!("could not parse S/MIME signed message: {e}");
                    body.smime_verified = Some(false);
                    body
                }
            }
        }
    }
}

// ── Tauri commands: own cert management ──────────────────────────────────────

/// Parses a PKCS#12 bundle (base64-encoded), unlocks it with `password`,
/// and stores the X.509 cert + private key in DER form for `account_id`.
/// The password itself is never persisted.
#[tauri::command]
pub async fn import_smime_cert(
    account_id: String,
    pkcs12_base64: String,
    password: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pkcs12_base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;

    let pkcs12 = Pkcs12::from_der(&bytes).map_err(|e| format!("could not parse PKCS#12: {e}"))?;
    let parsed = pkcs12
        .parse2(&password)
        .map_err(|e| format!("could not unlock PKCS#12 (wrong password?): {e}"))?;

    let cert = parsed.cert.ok_or("no certificate in PKCS#12")?;
    let pkey = parsed.pkey.ok_or("no private key in PKCS#12")?;

    let cert_der = cert.to_der().map_err(|e| e.to_string())?;
    let pkey_der = pkey.private_key_to_der().map_err(|e| e.to_string())?;
    let meta = cert_meta(&cert)?;

    let conn = cache::open()?;
    cache::upsert_smime_own_cert(
        &conn,
        &SmimeOwnCert {
            account_id,
            certificate: cert_der,
            private_key: pkey_der,
            fingerprint: meta.fingerprint,
            subject_cn: meta.subject_cn,
            not_after: meta.not_after,
        },
    )
}

/// Returns the public certificate for `account_id` as a PEM string — safe
/// to copy-paste or share with correspondents.
#[tauri::command]
pub async fn export_smime_cert(account_id: String) -> Result<String, String> {
    let conn = cache::open()?;
    let own = cache::get_smime_own_cert(&conn, &account_id)?
        .ok_or_else(|| format!("no S/MIME certificate for {account_id}"))?;
    let cert = X509::from_der(&own.certificate).map_err(|e| e.to_string())?;
    let pem = cert.to_pem().map_err(|e| e.to_string())?;
    String::from_utf8(pem).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_own_smime_certs() -> Result<Vec<SmimeOwnCertInfo>, String> {
    let conn = cache::open()?;
    Ok(cache::list_smime_own_certs(&conn)?
        .into_iter()
        .map(|c| SmimeOwnCertInfo {
            account_id: c.account_id,
            fingerprint: c.fingerprint,
            subject_cn: c.subject_cn,
            not_after: c.not_after,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_smime_cert(account_id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_smime_own_cert(&conn, &account_id)
}

// ── Tauri commands: contact cert management ───────────────────────────────────

/// Accepts a cert as PEM text or base64-encoded DER, stores it keyed by email.
#[tauri::command]
pub async fn import_contact_smime_cert(email: String, cert_pem_or_der_base64: String) -> Result<(), String> {
    let cert = parse_cert_pem_or_der(&cert_pem_or_der_base64)?;
    let meta = cert_meta(&cert)?;
    let der = cert.to_der().map_err(|e| e.to_string())?;

    let conn = cache::open()?;
    cache::upsert_smime_contact_cert(
        &conn,
        &SmimeContactCert {
            email: email.to_lowercase(),
            certificate: der,
            fingerprint: meta.fingerprint,
            subject_cn: meta.subject_cn,
            not_after: meta.not_after,
            added_at: Utc::now().to_rfc3339(),
        },
    )
}

#[tauri::command]
pub async fn list_contact_smime_certs() -> Result<Vec<SmimeContactCertInfo>, String> {
    let conn = cache::open()?;
    Ok(cache::list_smime_contact_certs(&conn)?
        .into_iter()
        .map(|c| SmimeContactCertInfo {
            email: c.email,
            fingerprint: c.fingerprint,
            subject_cn: c.subject_cn,
            not_after: c.not_after,
            added_at: c.added_at,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_contact_smime_cert(email: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_smime_contact_cert(&conn, &email)
}

// ── Tauri command: cert inspection ───────────────────────────────────────────

/// Parses a cert blob (PEM or base64 DER) without storing it — useful in the
/// import dialog to display what's inside before the user confirms.
#[tauri::command]
pub async fn get_smime_cert_info(cert_pem_or_der_base64: String) -> Result<SmimeCertInfo, String> {
    let cert = parse_cert_pem_or_der(&cert_pem_or_der_base64)?;
    let meta = cert_meta(&cert)?;
    Ok(SmimeCertInfo {
        fingerprint: meta.fingerprint,
        subject_cn: meta.subject_cn,
        issuer_cn: meta.issuer_cn,
        not_before: meta.not_before,
        not_after: meta.not_after,
        email_san: meta.email_san,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use openssl::asn1::Asn1Time;
    use openssl::bn::BigNum;
    use openssl::pkey::PKey;
    use openssl::rsa::Rsa;
    use openssl::x509::extension::SubjectAlternativeName;
    use openssl::x509::{X509Builder, X509NameBuilder};

    /// Generates a self-signed RSA-2048 cert with an email SAN for `email`.
    fn make_test_cert(email: &str, cn: &str) -> (X509, PKey<openssl::pkey::Private>) {
        let rsa = Rsa::generate(2048).expect("rsa keygen");
        let pkey = PKey::from_rsa(rsa).expect("pkey");

        let mut name = X509NameBuilder::new().expect("name builder");
        name.append_entry_by_text("CN", cn).expect("CN");
        let name = name.build();

        let mut builder = X509Builder::new().expect("x509 builder");
        builder.set_version(2).expect("set version");
        builder
            .set_serial_number(
                &BigNum::from_u32(1).expect("bn").to_asn1_integer().expect("asn1 int"),
            )
            .expect("serial");
        builder.set_subject_name(&name).expect("subject");
        builder.set_issuer_name(&name).expect("issuer");
        builder.set_pubkey(&pkey).expect("pubkey");
        builder
            .set_not_before(&Asn1Time::days_from_now(0).expect("not before"))
            .expect("set not_before");
        builder
            .set_not_after(&Asn1Time::days_from_now(365).expect("not after"))
            .expect("set not_after");

        // Email SAN so the signer email is extractable from the cert.
        let san = SubjectAlternativeName::new()
            .email(email)
            .build(&builder.x509v3_context(None, None))
            .expect("san");
        builder.append_extension(san).expect("append san");

        builder.sign(&pkey, MessageDigest::sha256()).expect("sign cert");
        (builder.build(), pkey)
    }

    /// Packs `(cert, pkey)` into an unencrypted PKCS#12 bundle (password = "").
    fn cert_to_pkcs12(cert: &X509, pkey: &PKey<openssl::pkey::Private>, name: &str) -> Vec<u8> {
        let pkcs12 = openssl::pkcs12::Pkcs12::builder()
            .name(name)
            .pkey(pkey)
            .cert(cert)
            .build2("")
            .expect("pkcs12 build");
        pkcs12.to_der().expect("pkcs12 to_der")
    }

    #[test]
    fn cert_meta_extracts_fields() {
        let (cert, _) = make_test_cert("alice@helix.test", "Alice Test");
        let meta = cert_meta(&cert).expect("cert_meta");
        assert_eq!(meta.subject_cn.as_deref(), Some("Alice Test"));
        assert_eq!(meta.email_san, vec!["alice@helix.test"]);
        assert!(!meta.fingerprint.is_empty());
        assert!(!meta.not_after.is_empty());
    }

    #[test]
    fn import_and_export_roundtrip_via_pkcs12() {
        let db_path = {
            let name = format!(
                "helix-smime-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            std::env::temp_dir().join(name).join("smime_test.sqlite3")
        };

        let (cert, pkey) = make_test_cert("bob@helix.test", "Bob Test");
        let p12_bytes = cert_to_pkcs12(&cert, &pkey, "bob");
        let p12_b64 = base64::engine::general_purpose::STANDARD.encode(&p12_bytes);

        // import
        let pkcs12_obj = Pkcs12::from_der(&p12_bytes).expect("from_der");
        let parsed = pkcs12_obj.parse2("").expect("parse2");
        let cert_in = parsed.cert.expect("cert");
        let pkey_in = parsed.pkey.expect("pkey");
        let meta = cert_meta(&cert_in).expect("cert_meta");

        let conn = cache::open_at(&db_path, "testkey123").expect("open");
        cache::upsert_smime_own_cert(
            &conn,
            &SmimeOwnCert {
                account_id: "bob@helix.test".to_string(),
                certificate: cert_in.to_der().expect("to_der"),
                private_key: pkey_in.private_key_to_der().expect("pkey to_der"),
                fingerprint: meta.fingerprint.clone(),
                subject_cn: meta.subject_cn.clone(),
                not_after: meta.not_after.clone(),
            },
        )
        .expect("upsert_smime_own_cert");

        let loaded = cache::get_smime_own_cert(&conn, "bob@helix.test")
            .expect("get_smime_own_cert")
            .expect("should exist");
        assert_eq!(loaded.fingerprint, meta.fingerprint);
        assert_eq!(loaded.subject_cn, meta.subject_cn);

        // round-trip the cert through DER
        let cert_back = X509::from_der(&loaded.certificate).expect("from_der");
        assert_eq!(
            cert_back.digest(MessageDigest::sha256()).expect("digest").to_vec(),
            cert_in.digest(MessageDigest::sha256()).expect("digest").to_vec()
        );
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let (cert, pkey) = make_test_cert("signer@helix.test", "Signer");
        let chain = Stack::new().expect("stack");
        let plaintext = b"Hello, S/MIME signing test!";

        let pkcs7 = Pkcs7::sign(&cert, &pkey, &chain, plaintext, Pkcs7Flags::STREAM)
            .expect("sign");
        let smime_output = pkcs7.to_smime(plaintext, Pkcs7Flags::STREAM).expect("to_smime");

        // Verify: structural check only (NOVERIFY skips chain validation).
        let (pkcs7_back, _) = Pkcs7::from_smime(&smime_output).expect("from_smime");
        let extra = Stack::<X509>::new().expect("extra stack");
        let store = X509StoreBuilder::new().expect("store builder").build();
        pkcs7_back
            .verify(&extra, &store, None, None, Pkcs7Flags::NOVERIFY)
            .expect("verify");

        // Check that the signer email is extractable from the signers list.
        let signers = pkcs7_back.signers(&extra, Pkcs7Flags::empty()).expect("signers");
        let signer = signers.iter().next().expect("one signer");
        let meta = cert_meta(signer).expect("cert_meta");
        assert_eq!(meta.email.as_deref(), Some("signer@helix.test"));
    }

    #[test]
    fn encrypt_and_decrypt_roundtrip() {
        let (cert, pkey) = make_test_cert("recipient@helix.test", "Recipient");
        let plaintext = b"Super secret S/MIME content!";

        let mut certs = Stack::new().expect("stack");
        certs.push(cert.clone()).expect("push cert");

        let pkcs7 = Pkcs7::encrypt(&certs, plaintext, Cipher::aes_256_cbc(), Pkcs7Flags::empty())
            .expect("encrypt");
        let smime_output = pkcs7.to_smime(&[], Pkcs7Flags::empty()).expect("to_smime");

        // Detect: header scan should recognise it as encrypted.
        assert!(matches!(detect_smime(&smime_output), SmimeKind::Encrypted));

        // Decrypt.
        let (pkcs7_back, _) = Pkcs7::from_smime(&smime_output).expect("from_smime");
        let decrypted = pkcs7_back
            .decrypt(&pkey, &cert, Pkcs7Flags::empty())
            .expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn get_smime_cert_info_parses_pem() {
        let (cert, _) = make_test_cert("info@helix.test", "Info User");
        let pem = cert.to_pem().expect("to_pem");
        let pem_str = String::from_utf8(pem).expect("utf8");

        let info = get_smime_cert_info(pem_str).await.expect("get_smime_cert_info");
        assert_eq!(info.subject_cn.as_deref(), Some("Info User"));
        assert!(info.email_san.iter().any(|e| e == "info@helix.test"));
        assert!(!info.fingerprint.is_empty());
    }

    #[test]
    fn split_smime_output_extracts_content_type() {
        // Minimal synthetic S/MIME envelope (just the structure, not a real signed message).
        let fake = b"MIME-Version: 1.0\r\nContent-Type: multipart/signed; protocol=\"application/pkcs7-signature\"; boundary=\"abc\"\r\n\r\n--abc\r\nContent-Type: text/plain\r\n\r\nHello\r\n--abc--\r\n";
        let (ct, body) = split_smime_output(fake).expect("split");
        assert!(ct.starts_with("multipart/signed"), "got: {ct}");
        assert!(body.starts_with(b"--abc"));
    }
}
