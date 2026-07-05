# Identities, mute threads, and unread count

Three small backend features that landed together in the same
`src-tauri/src/identities.rs` module:

## Send-as identities

An identity is a send-as alias for an account: a different From address
(e.g. `support@domain.com`) that uses the same account's SMTP credentials.
This is the standard way custom-domain mail providers let you send from
multiple addresses — the SMTP AUTH is always the primary account, but the
`From:` header changes.

### Schema

```sql
CREATE TABLE IF NOT EXISTS identities (
    account_id   TEXT NOT NULL,
    address      TEXT NOT NULL,
    display_name TEXT,
    signature    TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (account_id, address)
);
```

### Tauri commands

- **`add_identity(account_id, address, display_name?, signature?)`** — upserts
  (re-adding the same address updates display_name and signature in place).
- **`list_identities(account_id)`** — returns all send-as aliases for the
  account, ordered by `created_at`.
- **`delete_identity(account_id, address)`** — removes an alias; silently
  succeeds if not found.

### send_message integration

`smtp::send_message` gained a `from_override: Option<String>` parameter. When
set, it replaces the `From:` header while SMTP authentication still uses
`account_id`'s stored credential. This same field propagates through
`drafts::queue_for_send` and is persisted in the `outbox` table
(`from_override TEXT` column, additive migration), so a queued message
that's retried by `flush_outbox` keeps its original alias identity.

The compose UI is responsible for resolving the chosen identity's address
and passing it as `from_override` to `queue_for_send`. If the user picks
the primary account address, pass `None`.

## Mute thread

Muting silences a thread so that future arrivals don't trigger notifications
and are silently marked seen. The mute is stored locally per account.

### Schema

```sql
CREATE TABLE IF NOT EXISTS muted_threads (
    message_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    muted_at   TEXT NOT NULL,
    PRIMARY KEY (message_id, account_id)
);
```

`message_id` is the root message's `Message-ID` header with angle brackets
stripped — the same format `imap::fetch_message_body` returns in the
`message_id` field. Account-scoped so muting on one account doesn't affect
another.

### Tauri commands

- **`mute_thread(account_id, message_id)`**
- **`unmute_thread(account_id, message_id)`**
- **`is_thread_muted(account_id, message_id)`** → `bool`
- **`list_muted_threads(account_id)`** → `Vec<String>` (message IDs)

### What's still open

The IDLE new-mail handler (`idle.rs`) should call `cache::is_thread_muted`
before emitting `helix://imap-new-mail` — a muted thread arriving should
get silently marked seen rather than triggering a toast. `fetch_messages` /
`fetch_threaded_messages` should also set an `is_muted: bool` field on
`MessageSummary` so the message list can dim muted threads. Both of these
are small plumbing changes for the frontend wiring phase.

## Unread count (badge)

`cache::total_unseen_count(conn, account_id?)` counts rows where `seen = 0`
in `cached_messages`, optionally filtered to one account.

### Tauri command

- **`get_unseen_count(account_id?)`** → `u32`

The frontend calls this after `fetch_messages`, `set_message_seen`,
`set_messages_seen`, and on startup, then passes the count to Tauri's
notification plugin's badge API to update the dock/taskbar badge. The
actual OS badge call is a frontend concern (`@tauri-apps/plugin-notification`);
the backend only provides the count.

## Advanced search filters

`search_local_messages` (and its inner `search_cached_messages_filtered`)
now accept structured filter params alongside the free-text query:

| param | type | effect |
|---|---|---|
| `from_filter` | `Option<String>` | LIKE `%value%` on `from_addr` |
| `subject_filter` | `Option<String>` | LIKE `%value%` on `subject` |
| `has_attachment` | `Option<bool>` | reserved, not yet filtered (no cache column) |
| `is_unread` | `Option<bool>` | `seen = 0` (unread) or `seen = 1` (read) |
| `is_flagged` | `Option<bool>` | `flagged = 1` (flagged) or `flagged = 0` |
| `date_after` | `Option<String>` | `date >= value` (RFC 3339 string) |
| `date_before` | `Option<String>` | `date <= value` (RFC 3339 string) |

Two execution paths:

1. **FTS + filters** — when `query` is non-empty, filters are applied as
   additional WHERE clauses on the JOIN side of the FTS5 query. The FTS
   index stays fast; flag/date matching runs against the regular columns.
2. **Filter-only** — when `query` is empty but at least one filter is set,
   the FTS step is skipped entirely and the filters run against
   `cached_messages` directly. Returns nothing if no filters and no query
   are provided (would otherwise scan the entire cache).

The POP3 side skips `is_unread`/`is_flagged` (POP3 messages have no flags
in the cache schema) but supports `date_after`/`date_before` and
`from_filter`/`subject_filter`.
