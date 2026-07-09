# PGP / end-to-end encryption

`src-tauri/src/pgp.rs` adds OpenPGP key management, encryption/signing,
and decryption/verification on top of the existing IMAP/POP3/SMTP layers.

## Crate choice: `pgp` (rpgp), not `sequoia-openpgp`

|                | `pgp` (rpgp) 0.19.0 | `sequoia-openpgp` 2.3.0 |
|----------------|---------------------|--------------------------|
| License        | MIT OR Apache-2.0   | LGPL-2.0-or-later        |
| Shape          | pure Rust, low-level building blocks | comprehensive, higher-level |
| Real-world use | Delta Chat (an email client) | GnuPG-adjacent tooling   |

Every other dependency in this codebase is permissively licensed.
`sequoia-openpgp`'s LGPL would have been the first copyleft dependency at
a time when Helix's own license wasn't yet chosen. (Helix has since been
licensed GPL-3.0-only, which LGPL is compatible with -- the choice of
`pgp` stands on the other grounds regardless.) `pgp` is also proven
specifically for email encryption (Delta Chat uses it), not just generic
OpenPGP tooling.

## Private key protection: no separate passphrase

The secret key is stored ASCII-armored in the same SQLCipher-encrypted
local cache as accounts/contacts/cached mail (`cache.rs`'s `pgp_keys`
table) -- never plaintext on disk, same protection everything else in
that database already gets. There's no second, key-specific passphrase
on top of that (a deliberate choice, not an oversight -- this is an early
build with no passphrase-prompt UI/flow anywhere yet). This can be
layered on top later without moving where the key lives or touching its
schema.

## Scope: inline-armored PGP only, not PGP/MIME, in both directions

Real-world PGP/MIME (RFC 3156) needs multipart MIME construction: a
`multipart/encrypted` structure with an `application/pgp-encrypted`
control part and an `application/octet-stream` ciphertext part.
`send_message` now supports real multipart MIME for plain HTML/attachment
mail (see `smtp.md`), but `send_message`'s `encrypt` flag is a hard,
upfront error when combined with `html`/`attachments` (see "Encryption and
multipart don't mix" in `smtp.md`) -- so PGP/MIME isn't blocked by a
missing capability anymore, it's a deliberate scope boundary. Building
PGP/MIME receive-only support without equivalent send support would be a
confusing, asymmetric half-feature, so both directions still use
inline-armored PGP instead: a `-----BEGIN PGP MESSAGE-----` block as the
plain message text, which this codebase's existing plain-text send/fetch
paths already handle with no multipart work at all. Revisit once there's
an actual need to encrypt a message that also carries an HTML body or
attachments -- not before.

## Schema

Two tables in `cache.rs`'s encrypted database:

```sql
CREATE TABLE pgp_keys (
    account_id   TEXT PRIMARY KEY,
    public_key   TEXT NOT NULL,  -- ASCII-armored
    secret_key   TEXT NOT NULL,  -- ASCII-armored
    fingerprint  TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE pgp_contact_keys (
    email        TEXT PRIMARY KEY,
    public_key   TEXT NOT NULL,  -- ASCII-armored
    fingerprint  TEXT NOT NULL,
    imported_at  TEXT NOT NULL
);
```

Separate from `accounts`/`contacts` on purpose: not every account has
generated a key, not every contact has a known public key, and that
"maybe" relationship is what a separate table expresses, not a pile of
nullable columns bolted onto the tables those features already own.

## Key generation

`generate_keypair` produces an Ed25519 primary key (signing +
certification) with one Curve25519 ECDH encryption subkey -- the same
shape as the `pgp` crate's own `generate_key` example, minus the separate
authentication subkey this codebase has no use for. The User ID is
`"<name> <account_id>"`.

## Commands

- `generate_keypair(account_id, name)` / `import_own_key(account_id, armored_secret_key)` --
  two separate functions rather than one `import(is_secret: bool)`, since
  they touch different tables and mean different things (generate a new
  identity vs. restore an existing one).
- `export_public_key(account_id)` -- for sharing/backup.
- `import_contact_key(email, armored_public_key)` -- keyed by the email
  the caller associates the key with, not necessarily whatever User ID is
  embedded in the key. Returns the fingerprint, since manually verifying
  a fingerprint out-of-band is the entire point of importing a key with
  no keyserver/WKD lookup behind it.
- `list_own_keys()` / `list_contact_keys()` -- read-back listings so a
  key-management UI can redisplay stored keys after a reload, not just
  what was imported in the current session. `list_own_keys` returns the
  *public* half only (`cache::StoredOwnKey` has no secret field); the
  secret key never leaves `cache.rs` except inside the sign/decrypt
  operations that need it. Both carry the stored timestamp
  (`created_at`/`imported_at`).
- `delete_own_key(account_id)` / `delete_contact_key(email)` -- forget a
  stored key (to revoke or replace it). Deleting an absent key is a no-op
  success, matching `delete_contact`. `delete_contact_key` lowercases the
  email to match how `import_contact_key` stored it.

`encrypt_and_sign`/`decrypt_and_verify`/`maybe_decrypt` are internal
(`pub(crate)`, not commands) -- called from `smtp.rs`/`imap.rs`/`pop3.rs`,
the same way `imap::parse_message_body` is `pub(crate)` rather than a
command in its own right.

## Wiring

- **`smtp::send_message`** gained an `encrypt: bool` parameter, mirroring
  Compose's existing (currently inert) "Encrypt" toggle. Unlike the
  cache/contact writes elsewhere in this codebase, this is **not**
  best-effort: if `encrypt` is `true` and encryption fails (no recipient
  key on file, etc.), the send itself fails. Encryption that silently
  doesn't happen is the one failure mode this must never produce quietly.
- **`imap::fetch_message_body`** and **`pop3::fetch_message`** each call
  `pgp::maybe_decrypt` after their existing cache/contact steps. It only
  looks at the already-parsed body's text for the armor header -- no raw
  bytes or MIME-part inspection needed, which is why this didn't require
  touching `parse_message_body`'s parsing logic at all, only its return
  shape (it now also returns the sender's email, used to look up a
  signing key to verify against). Two new `MessageBody` fields,
  `pgp_signed_by: Option<String>` and `pgp_signature_valid: Option<bool>`,
  stay `None` for ordinary mail. If decryption is attempted but fails (no
  key, wrong key, corrupt data), the body comes back unchanged --
  still-armored text, fields still `None` -- rather than failing the
  whole fetch.

## What this doesn't do

- PGP/MIME, either direction (see Scope above).
- Passphrase protection on the secret key (see above).
- Keyserver lookup -- HKP/SKS/OpenPGP.org are not supported.
- WKD discovery is now supported via `discover_pgp_key_wkd(email)` (see
  below); manual import via `import_contact_key` still works alongside it.
- Trust models (web of trust, TOFU), key revocation, subkey management
  beyond what `generate_keypair`'s fixed shape produces.
- Compose/fetch wiring -- `send_message`'s `encrypt` flag and
  `fetch_message_body`/`pop3::fetch_message`'s automatic decrypt are
  still unreachable from the UI (Send isn't wired to any backend command
  at all yet, and there's no real `fetch_message_body` call either).
  Key management itself *is* now wired -- `src/components/
  PgpKeySettings.tsx` calls `generate_keypair`/`export_public_key`/
  `import_own_key`/`import_contact_key` for real. See
  `docs/technical/encryption.md` for the precise real-vs-placeholder
  boundary.

## Verification

- **Pure, no network or mail server** -- this is the one feature in the
  whole backlog that doesn't need GreenMail or a real mailbox to verify
  meaningfully, since it's all local cryptography: generate a keypair,
  encrypt-and-sign a message to that same key (self-test), decrypt-and-
  verify it, confirm the plaintext round-trips and the signature
  verifies. Plus negative cases -- decrypting with the wrong account's
  key fails cleanly, and encrypting to an email with no known public key
  returns a clear error rather than a silent plaintext fallback.
- **GreenMail, `#[ignore]`d**: `smtp::tests::
  sends_an_encrypted_message_and_decrypts_it_on_a_local_test_server`
  generates a real (disposable) keypair for the GreenMail test account,
  encrypts a message to itself, sends it over a real SMTPS connection,
  fetches it back over a real IMAP connection, and confirms the original
  plaintext comes back out with a verified signature -- encrypt over real
  SMTP, decrypt over real IMAP, the one true end-to-end proof. It cleans
  up the `pgp_keys`/`pgp_contact_keys` rows it creates in the real local
  cache afterward (same precedent as `credentials.rs`'s real-keychain
  test using a throwaway account and deleting it when done) -- confirmed
  manually that no rows were left behind after a run. Uses the same
  GreenMail container as the existing SMTP/IMAP tests
  (`docs/technical/smtp.md`), no extra setup needed.

## WKD key discovery

`pgp::discover_pgp_key_wkd(email)` fetches a contact's public key from
their domain's Web Key Directory (WKD) so the user doesn't have to import
it manually. It only *returns* the key (armored + fingerprint); it does
not store anything, so it's the right call behind an explicit,
fingerprint-first import UI.

The compose/encrypt flow instead uses `pgp::ensure_contact_key_wkd(email)`,
which wraps the fetch with a no-overwrite guard: if a key is already stored
for that address it is kept and returned untouched (`status:
"already_present"`), and WKD is only fetched-and-imported when nothing is
on file (`status: "imported"`). This matters because
`cache::upsert_contact_key` is an `ON CONFLICT(email) DO UPDATE` upsert —
calling `import_contact_key` for an address that already has a key
*replaces* it. That is correct for the key-management UI, where replacing a
key is a deliberate user action, but it must not happen on an unattended,
opportunistic acquisition: whatever a domain's WKD currently serves must
never be able to silently overwrite a key the user has verified and
trusted. `ensure_contact_key_wkd` therefore mirrors the exact no-overwrite
rule the Autocrypt harvester (`harvest_autocrypt`) applies to inbound
headers — both are keys the user didn't individually confirm.

**URL format (direct method):**

```
https://[domain]/.well-known/openpgpkey/hu/[hash]?l=[local]
```

`[hash]` is the first 10 bytes of the SHA-1 hash of the lowercased
local-part of the address, z-base-32 encoded (32-character custom alphabet
`ybndrfg8ejkmcpqxot1uwisza345h769` per the WKD spec). The response is a
binary Transferable Public Key (not ASCII-armored).

**Execution path:**

1. Split the email on `@` to get `local` and `domain`.
2. SHA-1 the lowercased local-part; take the first 10 bytes; z-base-32 encode.
3. Fetch the URL via an async `reqwest::Client` (the command is `async`,
   sharing Tauri's Tokio runtime).
4. Parse the binary response as a `SignedPublicKey` via the `pgp` crate's
   `from_bytes`.
5. Re-armor the key via `to_armored_string` and return it as
   `PublicKeyInfo { public_key, fingerprint }`. `discover_pgp_key_wkd`
   itself stores nothing — the caller decides whether to import (via
   `import_contact_key`, or the no-overwrite `ensure_contact_key_wkd`).

**What it doesn't do:**

- No advanced method (subdomain `openpgpkey.[domain]`) — most providers
  use direct only, and adding the fallback is straightforward later.
- No key validity / expiry check beyond what `from_bytes` enforces.
- No cross-certification check or trust model beyond fingerprint storage.
- No storage of its own: the compose UI drives acquisition through
  `ensure_contact_key_wkd` (no-overwrite) when the user enables encryption
  for a recipient with no stored key.
