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
- [x] STARTTLS support for SMTP — `send_message` takes a `use_starttls` flag and picks `lettre`'s `relay()` (implicit TLS) or `starttls_relay()` (STARTTLS) accordingly (`src-tauri/src/smtp.rs`) — see `smtp.md`
- [ ] HTML body / attachments for outgoing mail — `send_message` only sends plain text
- [x] Provider auto-discovery — `discover_server_config` resolves IMAP/SMTP host+port via a small hardcoded table (Gmail) then DNS SRV per RFC 6186 (`src-tauri/src/discovery.rs`) — see `provider-discovery.md`
- [ ] Expand the hardcoded provider table — currently only Gmail; add more providers once their exact implicit-TLS ports are verified
- [ ] Local encrypted cache schema — SQLite (`rusqlite`/`sqlx`) for offline message and attachment storage, encrypted at rest. Foundational: the offline draft queue, full-text search index, and contact/address cache below all build on this rather than each inventing their own local storage.
- [x] IMAP commands use the keychain — `list_folders`/`fetch_messages` take `account_id`, not a raw password; password is resolved from the keychain and zeroized after use (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] Account onboarding command — `add_account` stores + verifies a credential, rolling back on failure (`src-tauri/src/account.rs`) — see `account-onboarding.md`
- [ ] Multi-account model — how accounts are identified/stored, and how unified vs. siloed inbox views are computed
- [ ] PGP / end-to-end encryption support

## From the product requirements spec (table-stakes section)

Backend-relevant items pulled from the user's "1. Core Architecture &
Protocols" requirements pass. Some of what that section asked for is
already covered above (unified inbox → multi-account model; outgoing
HTML/attachments → the existing unchecked item; SSL/TLS enforcement →
already the case everywhere, there's no insecure-connection path in this
codebase at all). The rest is new:

- [ ] POP3 support — a `pop3.rs` module alongside `imap.rs`, for the
      "legacy offline download" case the spec calls out. Lower priority
      than the rest of this section: it's explicitly a legacy fallback,
      not how the primary sync model works.
- [ ] IMAP IDLE push notifications — needs a persistent, long-lived IMAP
      session per account instead of the current open-command-close
      pattern; `imap.rs` already flags this as the reason there's no
      connection pooling yet. The biggest architectural change in this
      list — touches connection lifecycle, not just one new command.
- [x] Mailbox mutation commands ("the big five") — `set_message_seen`,
      `set_message_flagged`, `move_message_to_folder` (archive/trash are
      just `move_message_to_folder` with the account's archive/trash
      folder name) via IMAP `UID STORE` and a three-tier `MOVE`/
      `UIDPLUS`/`SEARCH`-fallback strategy for moves (`src-tauri/src/
      imap.rs`) — see `mailbox-actions.md`
- [ ] Reply / Reply-All / Forward composition — building the right
      `In-Reply-To`/`References`/`Subject` (`Re:`/`Fwd:`) headers and
      resolving recipients from the original message, on top of
      `send_message`. Shares header-parsing groundwork with message
      threading below but is a distinct feature (composing one new
      message vs. grouping existing ones).
- [ ] Message threading — group messages into conversations using
      `References`/`In-Reply-To`/`Message-ID`, for the UI's threaded
      timeline view.
- [ ] Draft persistence — local autosave (depends on the local cache
      schema above) plus syncing to the account's IMAP Drafts folder via
      `APPEND`. "Auto-send on reconnection" implies an offline outbox
      queue, not just local storage of unsent drafts.
- [ ] Contact/address cache — local index of previously-seen addresses
      to power compose-time autocomplete. Depends on the local cache
      schema above.

Not backend work, tracked here only for visibility since they came from
the same spec: rich text/plain text composer toggle, drag-and-drop
attachment UI, and HTML sanitization of message bodies before render
(stripping scripts/tracking pixels/remote images) — all frontend-side.
The last one matters for this backend: `fetch_message_body`'s `html`
field is raw, unsanitized MIME content today, so whatever renders it
must not treat it as safe to inject as-is.

Each item should get its own doc here once it's actually implemented,
the same way credential storage did.
