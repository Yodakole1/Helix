# Scheduled send and undo send

Both features are built on top of the `outbox` table in `cache.rs` and the
`drafts::queue_for_send` / `flush_outbox` commands.

## How it works

`outbox` gained a `send_at TEXT` column (RFC 3339 or `NULL`). The column is
`NULL` for immediate sends and a future timestamp for scheduled ones.

### queue_for_send

```
queue_for_send(..., send_at: Option<String>) -> QueueResult
```

`QueueResult` is `{ sent: bool, outbox_id: Option<String> }`. The
`outbox_id` is now always returned (previously `None` on immediate success),
so the frontend has it available for the undo toast regardless of whether
the send was immediate, deferred, or failed.

- If `send_at` is `None` or in the past: attempts to send immediately,
  same as before. On success the outbox row is deleted.
- If `send_at` is in the future: inserts the row with the timestamp and
  returns `{ sent: false, outbox_id: Some(...) }` without attempting a
  send. The message stays in the outbox until `flush_outbox` is called
  after the timestamp has passed.

### flush_outbox

`flush_outbox` now skips rows whose `send_at` is still in the future, so
scheduled messages are not sent early by a reconnect or app-start flush.
Rows with no `send_at` (or a past `send_at`) are sent as before.

### cancel_queued_send

```
cancel_queued_send(outbox_id: String) -> bool
```

Deletes the outbox row if it still exists. Returns `true` if deleted,
`false` if the row was already gone (sent and cleaned up between the user
clicking Undo and the command arriving). The `false` case is a normal race
condition, not an error — the message was already sent.

**Undo send pattern (frontend):**
1. Call `queue_for_send(..., send_at: Some(now + 10s))`.
2. Show a toast "Sending in 10s... Undo".
3. On Undo click: call `cancel_queued_send(outbox_id)`.
4. On timer expire (or before): call `flush_outbox` to actually send.
   `flush_outbox` already runs on app start and on new-mail events.

**Send Later pattern (frontend):**
1. User picks a date/time in the compose UI.
2. Call `queue_for_send(..., send_at: Some(chosen_timestamp))`.
3. The outbox view shows the pending message with its scheduled time.
4. `flush_outbox` on every app wakeup checks and sends when the time comes.

## What this doesn't do yet

- **No background timer** — there's no background Tokio task that fires
  `flush_outbox` on a schedule. The flush happens on: app startup, a
  new-mail IDLE event, and explicit frontend calls. A scheduled message
  won't send while the app is closed. A background polling task would be the
  natural follow-up once IDLE is extended to drive a periodic flush.
- **No outbox backoff** — same as before: `flush_outbox` retries every
  eligible row on each call with no delay or cap.
- **POP3 accounts** — the outbox is SMTP-only; POP3 affects only receiving.

## Schema migration

`outbox` gains `send_at TEXT` via an additive `ALTER TABLE ADD COLUMN`
migration in `open_at`, same pattern as every prior column addition.
Existing rows get `NULL`, which `flush_outbox` treats as "send immediately".
