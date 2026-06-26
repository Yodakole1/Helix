# Encryption

Status: **Backend implemented. Frontend key management is now real;
compose-time encryption and the message-view crypto indicator are not.**
`src-tauri/src/pgp.rs` does real OpenPGP key generation/import,
encryption+signing, and decryption+verification, wired into
`send_message`/`fetch_message_body`/POP3's `fetch_message` — see
`pgp.md` for the full design. Settings' key-management section now calls
those commands directly; the rest of the frontend pieces described below
are still exactly as inert as when this doc was first written.

## What's real today

- **Settings > Privacy & Security's key-management section**
  (`src/components/PgpKeySettings.tsx`, via `src/lib/pgp.ts`) is the one
  place in the frontend that calls `pgp.rs`'s commands. Per the active
  account: checks whether a key already exists (`export_public_key`'s
  success/failure doubles as that check, since there's no separate
  `has_key` command), generates a new one (`generate_keypair`) or
  imports an existing one (`import_own_key`), and shows/copies the
  resulting fingerprint and armored public key. A separate, account-
  independent section imports a contact's public key
  (`import_contact_key`), showing the returned fingerprint -- there's no
  list/read command for contact keys yet, so previously-imported ones
  aren't shown after a reload, only what's imported in the current
  session.
- This works today the same way `AddAccountModal`'s `storeCredential`
  call does: it's a real call against one of the hardcoded `ACCOUNTS`
  identities (see `multi-account.md`), not against a fully onboarded,
  IMAP-verified account, since that flow doesn't exist in the frontend
  yet either.

## What's still a placeholder

- `ComposeModal` (`src/components/ComposeModal.tsx`) renders an "Encrypt"
  switch in its footer. Toggling it only flips local component state
  (`encrypt`); nothing reads that state when a message is actually sent
  (`handleClose`, wired to both Discard and Send, doesn't look at it at
  all). Sending isn't wired to a real backend command yet either — see
  `backend-backlog.md`.
- `SettingsModal`'s "Encrypt new messages by default" toggle
  (`encryptByDefault` state, lifted to `App.tsx`) only controls the
  *starting* value of compose's Encrypt switch for a fresh draft —
  encrypting on send still isn't wired (above).
- `ReaderPane`'s "Encrypted" / "Signed by ..." badge is driven by three
  new optional `SampleMessage` fields (`encrypted`, `pgpSignedBy`,
  `pgpSignatureValid`), set on exactly one sample message, the same way
  `hasRemoteImage` illustrates the image-blocking toggle. It is not real
  decryption output — there's no `fetch_message_body` call from the
  frontend yet (see `backend-backlog.md`), so there's nothing real to
  decrypt against. Don't extend this pattern to more messages or wire it
  to look more finished than it is; wire it to a real fetch instead once
  that exists.

## What "local encryption" means elsewhere in this project

The project's other privacy claim — local encryption — refers to
`src-tauri/src/cache.rs`'s SQLCipher-encrypted local message cache (see
`local-cache.md`), which is unrelated to *end-to-end* message encryption.
That part is real and implemented; the compose-time Encrypt toggle is not.

## Backend recap

`src-tauri/src/pgp.rs` generates/imports Ed25519+Curve25519 keypairs,
stores them in `cache.rs`'s `pgp_keys`/`pgp_contact_keys` tables, and
exposes `generate_keypair`/`export_public_key`/`import_own_key`/
`import_contact_key` as commands (all now called from the frontend, see
above). `send_message` has a new `encrypt` flag that encrypts-and-signs
the body (inline-armored PGP, not PGP/MIME — see `pgp.md` for why);
`fetch_message_body` and POP3's `fetch_message` both attempt
decryption+verification automatically when a fetched body looks like an
armored PGP message. Neither of those two is reachable from the UI yet —
that's the send/fetch wiring gap above, not a key-management gap.
