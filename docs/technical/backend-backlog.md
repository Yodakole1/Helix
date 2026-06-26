# Backend backlog

Tracking what's left on the backend side. Update this as items are
started or finished — check items off rather than deleting them, so the
history of what's been built stays visible.

- [x] Credential storage via OS keychain (`src-tauri/src/credentials.rs`) — see `credential-storage.md`
- [x] IMAP connection core — connect, authenticate, list folders (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] IMAP message fetching — `fetch_messages` returns UID/subject/from/date/seen for the most recent N messages in a folder (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] RFC 2047 header decoding — `decode_header_text` in `src-tauri/src/imap.rs` decodes encoded-word subjects/sender names, falling back to UTF-8 lossy on malformed input — see `imap-core.md`
- [x] Message body fetching — `fetch_message_body` parses text/HTML/attachment metadata for one message by UID via `mail-parser` (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] Attachment content download — `imap::fetch_attachment`/`pop3::pop3_fetch_attachment` download one attachment's bytes (base64-encoded over IPC), addressed by its `index` in `fetch_message_body`'s/`fetch_message`'s attachment list, via a shared `imap::extract_attachment` helper. Re-fetches and re-parses the whole message rather than an IMAP `BODY[<section>]` partial fetch — see `imap-core.md`. Bytes still aren't written to the local cache (no content column for them yet); no frontend wiring yet either.
- [x] SMTP sending — `send_message` via `lettre` (tokio1-native-tls transport), same account_id/keychain convention as IMAP (`src-tauri/src/smtp.rs`) — see `smtp.md`
- [x] STARTTLS support for SMTP — `send_message` takes a `use_starttls` flag and picks `lettre`'s `relay()` (implicit TLS) or `starttls_relay()` (STARTTLS) accordingly (`src-tauri/src/smtp.rs`) — see `smtp.md`
- [x] HTML body / attachments for outgoing mail — `send_message` gained `html: Option<String>` and `attachments: Vec<OutgoingAttachment>`; `build_multipart_body` builds real multipart MIME (`MultiPart::mixed()`/`alternative_plain_html()`/`Attachment`, via `lettre`) when either is supplied, otherwise unchanged single-`TEXT_PLAIN`-body behavior. `encrypt: true` combined with either is a hard upfront error — PGP support stays inline-armored plain-text only (see `pgp.md`), so encrypting a multipart message would mean silently encrypting only part of it — see `smtp.md`.
- [x] Provider auto-discovery — `discover_server_config` resolves IMAP/SMTP host+port via a small hardcoded table (Gmail) then DNS SRV per RFC 6186 (`src-tauri/src/discovery.rs`) — see `provider-discovery.md`
- [x] Expand the hardcoded provider table — added Fastmail (all domains), Yahoo/Ymail/Rocketmail, Zoho Mail, iCloud/me.com/mac.com (STARTTLS, port 587), and Outlook/Hotmail/Live/MSN (STARTTLS, port 587); `DiscoveredConfig` gained `smtp_use_starttls: bool` so the frontend can pass the right flag to `add_account` — see `provider-discovery.md`
- [x] Local encrypted cache schema — SQLCipher-encrypted SQLite (`rusqlite`) caching message summaries and bodies as they're fetched over IMAP, key managed via the OS keychain (`src-tauri/src/cache.rs`) — see `local-cache.md`. Now also home to the `accounts` and `contacts` tables below. Still no offline-read fallback for mail, and no attachment-bytes, draft-queue, or FTS tables — those are still the unimplemented items below.
- [x] IMAP commands use the keychain — `list_folders`/`fetch_messages` take `account_id`, not a raw password; password is resolved from the keychain and zeroized after use (`src-tauri/src/imap.rs`) — see `imap-core.md`
- [x] Account onboarding command — `add_account` stores + verifies a credential, rolling back on failure (`src-tauri/src/account.rs`) — see `account-onboarding.md`
- [x] Multi-account model — account metadata (host/port/folder names, never the password) persisted in the same encrypted local cache as mail, via `cache::AccountRecord`/`upsert_account`/`list_accounts`/`delete_account`; `account.rs` exposes `list_accounts`/`remove_account` and a `fetch_unified_inbox` command that fans out across every stored account and merges by date — see `multi-account.md`
- [x] PGP / end-to-end encryption support — `src-tauri/src/pgp.rs` via the `pgp` (rpgp) crate: key generation/import, encrypt+sign wired into `send_message` (an `encrypt` flag, hard-fails rather than silently sending plaintext), decrypt+verify wired into `fetch_message_body`/POP3's `fetch_message`. Inline-armored PGP only, not PGP/MIME, in both directions -- a deliberate scope boundary, not (any longer) a forced one now that outgoing mail supports real multipart -- see `pgp.md`. Frontend now has a real key-management UI (`PgpKeySettings.tsx`) calling `generate_keypair`/`export_public_key`/`import_own_key`/`import_contact_key`; Compose's Encrypt toggle and the Settings default-state setting are still unwired to actual send/fetch — see `encryption.md`.

## From the product requirements spec (table-stakes section)

Backend-relevant items pulled from the user's "1. Core Architecture &
Protocols" requirements pass. Some of what that section asked for is
already covered above (unified inbox → multi-account model; outgoing
HTML/attachments → the now-checked item above; SSL/TLS enforcement →
already the case everywhere, there's no insecure-connection path in this
codebase at all). The rest is new:

- [x] POP3 support — hand-rolled (no async POP3 crate needed) `pop3.rs`
      module alongside `imap.rs`: `list_messages`/`fetch_message`/
      `delete_message` over POP3S only (no STARTTLS/plaintext path),
      reusing `imap::parse_message_body` for the RETR-to-MessageBody
      step — see `pop3.md`. Not integrated with the local cache or the
      account model yet (see that doc's "what this doesn't do" section).
- [x] IMAP IDLE push notifications — `src-tauri/src/idle.rs`: persistent
      per-account Tokio task owned by `IdleRegistry` (Tauri managed state).
      Falls back to 60-second EXAMINE polling for servers without IDLE
      capability. Emits `"helix://imap-new-mail"` Tauri events when EXISTS
      increases; the frontend listens and triggers a `fetch_messages` refresh.
      Reconnects with exponential backoff (1 s → 5 min) on error.
      `start_idle`/`stop_idle`/`stop_all_idle` Tauri commands. `ImapSession`
      and `login_with_stored_credential` are now `pub(crate)` so `idle.rs`
      (and `drafts.rs`) can open their own sessions — see `idle.md`.
- [x] Mailbox mutation commands ("the big five") — `set_message_seen`,
      `set_message_flagged`, `move_message_to_folder` (archive/trash are
      just `move_message_to_folder` with the account's archive/trash
      folder name) via IMAP `UID STORE` and a three-tier `MOVE`/
      `UIDPLUS`/`SEARCH`-fallback strategy for moves (`src-tauri/src/
      imap.rs`) — see `mailbox-actions.md`
- [x] Reply / Reply-All / Forward composition — `imap::MessageBody`
      gained `from`/`to`/`cc`/`reply_to` (formatted recipient strings) and
      `message_id`/`in_reply_to`/`references` (threading headers, angle
      brackets stripped) so a caller can resolve who a reply should go to
      and what headers it needs; `smtp::send_message` gained
      `in_reply_to`/`references` params that set the real RFC 5322
      headers (re-wrapped in `<...>`) so a sent reply actually threads in
      a real mail client. `Subject`'s `Re:`/`Fwd:` prefixing is unchanged
      — still the caller's job, same as before this landed. Shares
      header-parsing groundwork with message threading below (same three
      headers, parsed once) but is a distinct feature (composing one new
      message vs. grouping existing ones) — see `imap-core.md`/`smtp.md`.
      The frontend prefill side (Reply All / Forward buttons in
      `ReaderPane`, building a `ComposePrefill` the same way Reply already
      did) still only has sample data to work with — see
      `frontend-layout.md`. Recipient self-exclusion for Reply-All's Cc
      list (don't Cc the user's own account) is left to whoever composes
      the reply, not decided in the backend.
- [x] Message threading — `MessageSummary` gained `message_id`/`in_reply_to`
      (extracted from IMAP ENVELOPE, no extra round-trip), `group_into_threads`
      groups a flat summary list into a `Vec<ThreadedMessage>` tree using
      `In-Reply-To`/`Message-ID` matching, and `fetch_threaded_messages` is
      a new Tauri command that fetches and groups in one call. Orphaned replies
      (parent outside the fetch window) become roots; cycles are silently
      dropped. Frontend still calls `fetch_messages` and renders a flat list
      -- wiring the threaded view is tracked in `frontend-roadmap.md`. See
      `threading.md`.
- [x] Draft persistence — `src-tauri/src/drafts.rs`: `drafts` and `outbox`
      tables added to the SQLCipher cache (`cache.rs`), `AccountRecord` gains
      `drafts_folder`. `save_draft` stores locally first and best-effort
      APPENDs to the server's Drafts folder (IMAP APPEND with `\Draft \Seen`
      flags); old server copies are expunged before each re-save.
      `queue_for_send` inserts to the outbox then immediately tries SMTP; on
      failure the row stays for `flush_outbox` to retry on reconnect (call
      `flush_outbox` on startup or when `helix://imap-new-mail` fires).
      `list_drafts`/`get_draft`/`delete_draft`/`list_outbox` round out the
      frontend-facing API — see `drafts.md`.
- [x] Contact/address cache — `contacts` table in the same encrypted
      cache, populated from `fetch_message_body`'s From/To/Cc and
      `send_message`'s recipient, searchable via `search_contacts` for
      compose-time autocomplete — see `contacts.md`

Not backend work, tracked here only for visibility since they came from
the same spec: rich text/plain text composer toggle, drag-and-drop
attachment UI, and HTML sanitization of message bodies before render
(stripping scripts/tracking pixels/remote images) — all frontend-side.
The last one matters for this backend: `fetch_message_body`'s `html`
field is raw, unsanitized MIME content today, so whatever renders it
must not treat it as safe to inject as-is. HTML sanitization + rendering
now exists frontend-side (`src/lib/sanitizeHtml.ts` + a sandboxed
`<iframe>` in `ReaderPane`, see `frontend-layout.md`), but only against
sample data — nothing feeds it `fetch_message_body`'s real `html` field
yet, so the "don't treat it as safe" warning above still fully applies
once that wiring happens. `ReaderPane` also now renders every attachment
a message has (`getAttachments`, was capped at one), still with no real
download wired up — the backend side (`fetch_attachment`/
`pop3_fetch_attachment`, see the "Attachment content download" item above)
exists now, nothing in the frontend calls it yet.

Each item should get its own doc here once it's actually implemented,
the same way credential storage did.
