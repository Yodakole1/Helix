# Backend backlog

Tracking what's left on the backend side. Update this as items are
started or finished — check items off rather than deleting them, so the
history of what's been built stays visible.

- [x] Credential storage via OS keychain (`src-tauri/src/credentials.rs`) — see `credential-storage.md`
- [x] IMAP connection core — connect, authenticate, list folders (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] IMAP message fetching — `fetch_messages` returns UID/subject/from/date/seen for the most recent N messages in a folder (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] RFC 2047 header decoding — `decode_header_text` in `src-tauri/src/imap.rs` decodes encoded-word subjects/sender names, falling back to UTF-8 lossy on malformed input — see `imap-core.md`
- [x] Message body fetching — `fetch_message_body` parses text/HTML/attachment metadata for one message by UID via `mail-parser` (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [ ] Attachment content download — `fetch_message_body` only returns attachment metadata, not bytes
- [x] SMTP sending — `send_message` via `lettre` (tokio1-native-tls transport), same account_id/keychain convention as IMAP (`src-tauri/src/smtp.rs`) — see `smtp.md`
- [ ] STARTTLS support for SMTP — only implicit TLS (port 465 style) is supported right now
- [ ] HTML body / attachments for outgoing mail — `send_message` only sends plain text
- [x] Provider auto-discovery — `discover_server_config` resolves IMAP/SMTP host+port via a small hardcoded table (Gmail) then DNS SRV per RFC 6186 (`src-tauri/src/discovery.rs`) — see `provider-discovery.md`
- [ ] Expand the hardcoded provider table — currently only Gmail; add more providers once their exact implicit-TLS ports are verified
- [ ] Local encrypted cache schema — SQLite (`rusqlite`/`sqlx`) for offline message and attachment storage, encrypted at rest
- [x] IMAP commands use the keychain — `list_folders`/`fetch_messages` take `account_id`, not a raw password; password is resolved from the keychain and zeroized after use (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] Account onboarding command — `add_account` stores + verifies a credential, rolling back on failure (`src-tauri/src/account.rs`) — see `account-onboarding.md`
- [ ] Multi-account model — how accounts are identified/stored, and how unified vs. siloed inbox views are computed
- [ ] PGP / end-to-end encryption support

Each item should get its own doc here once it's actually implemented,
the same way credential storage did.
