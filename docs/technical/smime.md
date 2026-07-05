# S/MIME signing and encryption

S/MIME uses X.509 certificates instead of PGP keys. Like PGP, it provides
signing (proves the message came from you) and encryption (only the intended
recipient can read it). Unlike PGP it is standardized into the MIME structure
rather than living as inline armored text, and certificates are trusted the
same way HTTPS certificates are — through a chain to a CA root.

This doc describes the S/MIME implementation in `src-tauri/src/smime.rs`.
The module landed in the same branch as CardDAV (`backend-starttls-pop3-account-features`).
PGP and S/MIME are independent parallel features; an account can have both.

## Scope

- **Sign outgoing messages** (`multipart/signed` with a detached PKCS#7
  signature part).
- **Encrypt outgoing messages** (`application/pkcs7-mime;
  smime-type=enveloped-data`).
- **Verify incoming signed messages** — extract the sender certificate,
  check the signature, return a verified flag + signer email to the frontend.
- **Decrypt incoming encrypted messages**.
- **Harvest sender certificates** from signed messages the user opens (same
  trigger point contact harvesting uses in `imap::fetch_message_body`).
- **Certificate management UI** — import a PKCS#12 file for own key/cert,
  import/delete contact certificates manually.

Explicitly out of scope for the initial implementation:
- Full X.509 chain validation against a trusted CA store. The `openssl`
  crate can do this, but it requires shipping or locating a trust store on
  every platform; for a first cut, "signature structurally valid" is reported
  separately from "chain trusted." A "trusted by OS" flag can be layered on
  later.
- OCSP stapling / CRL checking.
- Certificate renewal / expiry enforcement (expiry is stored and shown; the
  app doesn't block sends on expired own certs yet).
- S/MIME + HTML/attachments together — same constraint as PGP: encrypting
  only part of a multipart message is worse than not encrypting. If
  `smime_encrypt: true` is passed with `html` or `attachments`, return an
  error, not a partial-encryption.

## Crate: `openssl` (vendored)

`openssl = { version = "0.10", features = ["vendored"] }` plus
`openssl-sys = { version = "0.9", features = ["vendored"] }`.

The `vendored` feature compiles OpenSSL from source and links it statically,
which means the app works on any Linux distro regardless of which version of
`libssl` is installed (or not). OpenSSL 3.x is MIT-licensed compatible with
Helix's planned permissive license; every other dep here is also permissive.

`openssl::pkcs7::Pkcs7` handles sign/verify/encrypt/decrypt in one API.
`openssl::x509::X509` represents certificates. `openssl::pkcs12::Pkcs12`
imports the `.p12`/`.pfx` files users receive from CAs or export from their
mail clients.

No other crate is needed. The openssl crate is the established choice for
this kind of PKCS#7/CMS work in Rust — there is no pure-Rust alternative
that covers the full S/MIME operation set yet.

## Schema

Two new tables added to `ensure_schema` in `cache.rs`, same encrypted
SQLCipher database as everything else:

```sql
CREATE TABLE IF NOT EXISTS smime_own_certs (
    account_id   TEXT PRIMARY KEY,
    certificate  BLOB NOT NULL,   -- DER-encoded X.509
    private_key  BLOB NOT NULL,   -- DER-encoded PKCS#8 (unencrypted inside
                                  -- the SQLCipher-encrypted DB)
    fingerprint  TEXT NOT NULL,   -- hex SHA-256 of DER cert, for display
    subject_cn   TEXT,            -- CN from the cert subject, for display
    not_after    TEXT NOT NULL    -- ISO 8601 expiry date
);

CREATE TABLE IF NOT EXISTS smime_contact_certs (
    email        TEXT NOT NULL PRIMARY KEY,  -- lowercased
    certificate  BLOB NOT NULL,   -- DER-encoded X.509
    fingerprint  TEXT NOT NULL,
    subject_cn   TEXT,
    not_after    TEXT NOT NULL,
    added_at     TEXT NOT NULL    -- ISO 8601, for the management UI
);
```

No `created_at` column on `smime_own_certs` — the cert's own `not_before`
carries that information and avoids a redundant field. One cert per account
(PRIMARY KEY is `account_id`), same as `pgp_keys`.

Private keys are DER-encoded PKCS#8 and stored unencrypted inside the
SQLCipher-encrypted database — same rationale as PGP secret keys in
`pgp_keys`. There is no per-key passphrase on top of the database's
own encryption yet; that can be layered in later without moving the key.

## Tauri commands (`smime.rs`)

### Own certificate management

```
import_smime_cert(account_id: String, pkcs12_base64: String, password: String)
    -> Result<(), String>
```
Base64-decode the PKCS#12 blob, parse with `openssl::pkcs12::Pkcs12::from_der`,
unlock with `password`, extract the `X509` cert and `PKey` private key.
Convert both to DER (`cert.to_der()`, `pkey.private_key_to_der()`),
compute the SHA-256 fingerprint (`cert.digest(MessageDigest::sha256())`),
read `not_after` from the cert, upsert into `smime_own_certs`. Password must
never be stored.

```
export_smime_cert(account_id: String) -> Result<String, String>
```
Returns the public certificate as a PEM string (`cert_from_der(...).to_pem()`)
so the user can copy-paste it to share with correspondents or upload to a
key directory.

```
list_own_smime_certs() -> Result<Vec<SmimeOwnCertInfo>, String>
```
`SmimeOwnCertInfo`: `{ account_id, fingerprint, subject_cn, not_after }`.
No private key material in the return value.

```
delete_smime_cert(account_id: String) -> Result<(), String>
```
Deletes from `smime_own_certs`. Does not remove contact certs.

### Contact certificate management

```
import_contact_smime_cert(email: String, cert_pem_or_der_base64: String)
    -> Result<(), String>
```
Tries PEM parse first, falls back to DER. Extracts fingerprint and `not_after`.
Upserts into `smime_contact_certs` keyed on lowercased email.

```
list_contact_smime_certs() -> Result<Vec<SmimeContactCertInfo>, String>
```
`SmimeContactCertInfo`: `{ email, fingerprint, subject_cn, not_after, added_at }`.

```
delete_contact_smime_cert(email: String) -> Result<(), String>
```

### Debug / key inspection

```
get_smime_cert_info(cert_pem_or_der_base64: String) -> Result<SmimeCertInfo, String>
```
Parses a cert blob (not yet stored) and returns metadata — useful for the
import dialog to show what's inside a file before the user confirms import.
`SmimeCertInfo`: `{ fingerprint, subject_cn, issuer_cn, not_before, not_after,
email_san }` where `email_san` is the Subject Alternative Name email list if
present (many S/MIME CAs put the email in SAN, not just CN).

## Integration with `send_message`

`send_message` gains two new optional params:

```rust
smime_sign: Option<bool>,     // default: false
smime_encrypt: Option<bool>,  // default: false
```

Validation (before any send attempt):
- If `smime_encrypt: true` and `html.is_some() || !attachments.is_empty()`:
  hard error, same constraint as PGP.
- If `smime_sign: true` and no cert for `account_id` in `smime_own_certs`:
  hard error ("no S/MIME certificate for this account").
- If `smime_encrypt: true` and no cert for the recipient in
  `smime_contact_certs`: hard error ("no S/MIME certificate for recipient").

Build path when S/MIME is active:

1. Build the plaintext `Message` bytes exactly as today (headers + body,
   no multipart wrapping yet).
2. **Sign**: `Pkcs7::sign(&cert, &pkey, &ca_chain, &data, Pkcs7Flags::STREAM)`
   — produces a `multipart/signed` MIME structure. `ca_chain` is empty for a
   self-signed cert; for a CA-issued cert the chain is embedded in the PKCS#12
   and stored alongside the cert (add a `chain` BLOB column for this).
3. **Encrypt** (after sign, or standalone): `Pkcs7::encrypt(
   &[recipient_cert], &data, Cipher::aes_256_cbc(), Pkcs7Flags::empty())`
   — produces `application/pkcs7-mime; smime-type=enveloped-data`.
4. Rebuild the final `lettre::Message` with the PKCS#7 output as the body,
   the correct Content-Type, and the original headers (From/To/Subject/etc.)
   taken from the pre-sign message. `lettre` doesn't understand S/MIME
   structure natively, so the signed/encrypted bytes are injected as a raw
   `SinglePart` body with a manually set `Content-Type` header.

## Integration with `fetch_message_body`

`MessageBody` gains two new fields:

```rust
pub smime_signed: bool,
pub smime_verified: Option<bool>,   // None = not signed, Some(true/false)
pub smime_encrypted: bool,
pub smime_signer_email: Option<String>,
```

Detection logic in `parse_message_body` (already `pub(crate)` for POP3 to
reuse):

1. Check the `Content-Type` of the outermost part:
   - `multipart/signed; protocol="application/pkcs7-signature"` → signed
   - `application/pkcs7-mime; smime-type=enveloped-data` → encrypted
   - Both can nest (sign-then-encrypt or encrypt-then-sign).

2. **Decrypt**: If encrypted, look up own cert for `account_id`. Call
   `Pkcs7::from_der(ciphertext)`, then `pkcs7.decrypt(&pkey, &cert,
   Pkcs7Flags::empty())`. On success, parse the decrypted bytes as a new
   MIME message and extract the body. On failure (no key, wrong key, corrupt):
   set `smime_encrypted: true` and return the body as-is (armored ciphertext
   in the body field, same best-effort posture as PGP).

3. **Verify**: If signed, call `Pkcs7::from_der(sig_bytes)`, then
   `pkcs7.verify(certs, store, Some(signed_data), None, Pkcs7Flags::NOVERIFY)`.
   `NOVERIFY` skips chain validation (for now). Extract the signer certificate
   from the `pkcs7.signers()` result, read its `subject_alternative_names()`
   and `subject_name()` to find the email. Set `smime_verified: Some(true/false)`.

4. **Harvest**: If verified successfully, upsert the signer's X.509 cert into
   `smime_contact_certs` (DER bytes from `cert.to_der()`). Same trigger point
   and best-effort posture as contact address harvesting.

## Certificate harvesting trigger

Same place as contact address harvesting: `imap::fetch_body_by_uid` and
`pop3::fetch_message`. When the parsed body has `smime_signed: true` and
`smime_verified: Some(true)` and a `smime_signer_email`, upsert the signer
cert. This means opening a signed message from someone is enough to
auto-import their cert — the user can then encrypt replies to them without
a separate import step.

## Tests

Six unit tests in `smime::tests`, all run by `cargo test` with no network or
Docker needed:

- `cert_meta_extracts_fields` — SHA-256 fingerprint, CN, SAN email all parse.
- `import_and_export_roundtrip_via_pkcs12` — PKCS#12 round-trip through
  the import/get/export path (DB via `cache::open_at`).
- `sign_and_verify_roundtrip` — sign plaintext bytes, verify structural
  validity, check signer email extracted from `signers()`.
- `encrypt_and_decrypt_roundtrip` — encrypt to a cert, `detect_smime`
  identifies encrypted structure, decrypt recovers original plaintext.
- `get_smime_cert_info_parses_pem` — PEM input → `SmimeCertInfo`.
- `split_smime_output_extracts_content_type` — structural split on a
  synthetic S/MIME envelope.

Note: OpenSSL (vendored, ≤ 3.x) writes `application/x-pkcs7-mime` rather
than the RFC 5751 name `application/pkcs7-mime`. `detect_smime` accepts
both spellings for compatibility with incoming mail that may use either.
The same dual-check applies to `application/x-pkcs7-signature`.

## Obtaining an S/MIME certificate

Helix doesn't generate S/MIME certificates itself (unlike PGP where key
generation is a single command). Users need to get one from outside:

- **Self-signed** (for testing): `openssl req -x509 -newkey rsa:4096
  -keyout key.pem -out cert.pem -days 365 -subj "/CN=Name/emailAddress=user@example.com"`
  then pack into PKCS#12: `openssl pkcs12 -export -out cert.p12 -inkey key.pem
  -in cert.pem`. Most mail clients will refuse to trust a self-signed cert's
  signature but will still be able to encrypt to the cert's public key.
- **Free CA-issued**: Actalis offers free personal S/MIME certificates.
  The PKCS#12 bundle can be imported directly into Helix.
- **Paid CA-issued**: Comodo/Sectigo, DigiCert, GlobalSign. Same PKCS#12
  import path.

The frontend's import UI should point users at one of the free options with
a direct link — the "get a certificate" step is the biggest friction point
for S/MIME compared to PGP where Helix generates the key itself.

## How this differs from PGP

| | PGP (existing) | S/MIME (this doc) |
|---|---|---|
| Key generation | In-app (`generate_keypair`) | External CA required |
| Key format | ASCII-armored OpenPGP | DER/PEM X.509 + PKCS#12 |
| Trust model | Web of trust / TOFU | X.509 chain to CA root |
| Message format | Inline armored text | MIME structure (`multipart/signed`) |
| Body constraint | Plain text only | Same (no multipart with encrypt) |
| Storage | `pgp_keys` / `pgp_contact_keys` | `smime_own_certs` / `smime_contact_certs` |
| Crate | `pgp` (rpgp) | `openssl` |

The two systems are independent and parallel — an account can have both a
PGP key and an S/MIME certificate. The `send_message` flags for each are
separate; they do not interact.
