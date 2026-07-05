# Drafts and outbox

`src-tauri/src/drafts.rs` adds local draft persistence and a send-on-
reconnect outbox queue, backed by two tables in the SQLCipher cache
(`drafts`, `outbox` — see `local-cache.md`).

## Drafts

A draft is stored locally first and best-effort APPENDed to the server's
Drafts folder. `save_draft` returns a stable `draft_id` the caller passes
back on the next autosave so the same row is updated in place rather than
piling up new rows.

- **`save_draft(account_id, imap_host, imap_port, drafts_folder, draft_id,
  to, subject, body_text, body_html, in_reply_to, references,
  attachments)`** → `draft_id`. Upserts the local `drafts` row, then calls
  `append_draft_to_imap` (best-effort: a failure is logged, not surfaced —
  the local copy is the source of truth). Any prior server copy of the
  draft (tracked by `imap_uid`) is expunged before the updated version is
  APPENDed, so the Drafts folder doesn't accumulate stale copies.
- **`list_drafts` / `get_draft` / `delete_draft`** round out the API.
  `delete_draft` removes the local row and best-effort expunges the server
  copy.

### Why manual MIME, not lettre

`build_raw_draft_bytes` hand-builds the RFC 2822 message rather than going
through `lettre` (as `send_message` does). A draft is normally incomplete
while being composed — a missing or malformed `To` is expected — and
`lettre`'s builder would reject that. Manual construction tolerates it,
and the result is only ever APPENDed to the server, never sent.

### Attachments

`save_draft` takes an `attachments: Vec<smtp::OutgoingAttachment>`
(reusing SMTP's attachment type). They're stored on the draft row as a
JSON string (`DraftRecord.attachments_json`, an opaque column from the
cache layer's point of view, mirroring how `OutboxRecord` stores its
attachments) and re-attached to the IMAP APPEND:

- With no attachments, `build_raw_draft_bytes` emits a single
  `text/plain` body, unchanged from before.
- With attachments, it emits `multipart/mixed`: the text body as the first
  part, then each attachment as a base64 part — the same structure
  `smtp::build_multipart_body` produces for a real send, hand-built here
  for the same incomplete-draft tolerance. `wrap_base64` re-flows the
  (already-base64) attachment content to 76-char lines per RFC 2045.

The round trip is unit-tested without a network: build a multipart draft,
parse it back with `mail_parser`, and assert the body text and the
attachment's name/bytes survive (`builds_a_multipart_draft_that_round_trips_through_a_parser`).

## Outbox (send on reconnect)

- **`queue_for_send(...)`** inserts an `outbox` row, then immediately
  attempts `smtp::send_message`. On success the row is deleted and
  `QueueResult { sent: true }` returned; on failure the row stays (with
  `attempt_count`/`last_error` recorded) and `sent: false` comes back so
  the caller knows to retry later. Takes `cc`/`bcc` (comma-separated
  address lists, same shape as `to`) alongside `to`; they're persisted on
  the row (`outbox.cc`/`outbox.bcc`, additive-migration TEXT columns
  defaulting to `''`) and passed through to `send_message`, so a queued
  message that's retried later keeps its full recipient set rather than
  silently sending to To only.
- **`flush_outbox(account_id)`** retries every queued message, resolving
  the account's SMTP settings from the cache so the caller doesn't re-pass
  them. Sent rows are deleted; still-failing rows have their attempt
  counter bumped. Call it on startup or when connectivity returns
  (e.g. on a `helix://imap-new-mail` event).

## Draft HTML round-trip

`build_raw_draft_bytes` now emits the correct MIME structure for every
combination of text, HTML, and attachments:

- Text only, no attachments → single `text/plain` part (unchanged).
- Text + HTML, no attachments → `multipart/alternative` (text then html).
- Text (+ optional HTML) + attachments → `multipart/mixed` wrapping a
  `text/plain` or `multipart/alternative` body part, followed by the
  attachment parts.

This matches `smtp::build_multipart_body`'s structure exactly, so a draft
APPENDed to the server and opened in another client (Thunderbird, Apple Mail,
Outlook) shows the HTML body rather than falling back to plain text.

## What this doesn't do yet

- **No APPENDUID tracking.** `cache::update_draft_imap_uid` exists but
  isn't called — most servers don't return APPENDUID, so a draft's
  server-side UID is only known if one happens to. Re-saves rely on the
  stored `imap_uid` when present and otherwise just APPEND a fresh copy.
- **No outbox backoff.** `flush_outbox` retries every eligible queued row
  on each call with no delay or cap; a persistently-rejecting server is
  retried every reconnect.

## Drafts-folder self-heal (added later)

`append_draft_to_imap` heals a wrong drafts-folder name the same way
`smtp::append_to_sent` heals Sent (see `smtp.md`): on APPEND failure it
resolves the real folder from LIST, retries, and persists the correction.
The frontend also stopped hardcoding "Drafts" -- `App.tsx` passes the
account record's `drafts_folder` into the compose draft context, and
compose auto-saves now include the rich-text HTML body (`bodyHtml`), not
just the plain text.
