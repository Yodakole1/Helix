# Local encrypted cache

A local SQLite database that mirrors message data fetched over IMAP, so
later features (offline reads, a draft/outbox queue, full-text search, a
contact/address cache) have one shared storage layer to build on instead
of each inventing its own. The database file is encrypted at rest, since
it's a permanent local copy of mail content rather than a transient
in-memory fetch.

## Implementation

`src-tauri/src/cache.rs` wraps [`rusqlite`](https://crates.io/crates/rusqlite)
built with the `bundled-sqlcipher` feature, so every connection is a
SQLCipher-encrypted SQLite database rather than plain SQLite.

- `open()` resolves the cache file's path via the
  [`dirs`](https://crates.io/crates/dirs) crate (`dirs::data_dir()`)
  joined with `dev.helix.app` -- the same identifier `credentials.rs`
  already uses to namespace keychain entries, now reused as
  `pub(crate) credentials::SERVICE_NAME` so both the keychain and the
  on-disk cache live under one real, consistent app identifier. (This is
  deliberately not Tauri's own `app_data_dir()` -- that depends on
  `tauri.conf.json`'s `identifier`, which is still the placeholder
  `com.tauri.dev` and not the thing actually used to namespace anything
  else in this codebase.)
- `open_at(path, key)` is the actual connection-opening logic, split out
  from `open()` so tests can exercise it against a temp-dir path and an
  explicit key without touching the real OS keychain or app data
  directory -- same testability split as `imap.rs`'s
  `connect_and_login`/`fetch_recent_messages`. It creates the parent
  directory if needed, opens the file, sets `PRAGMA key = "x'<hex>'"`
  (SQLCipher's raw-key syntax -- the key is already high-entropy, so there's
  no passphrase to derive a key from), and then runs a throwaway
  `SELECT count(*) FROM sqlite_master` query. SQLCipher doesn't actually
  validate a key until the first real read touches the file, so this
  forces that check immediately: a wrong key fails right here with a
  clear error, not confusingly on whatever query happens to run first
  later.
- One connection per call, no pooling -- same "open and close per
  command" pattern `imap.rs` uses for IMAP sessions, for the same reason:
  there's no concrete need for a long-lived connection yet.
- No migration framework. `ensure_schema` is one idempotent
  `CREATE TABLE IF NOT EXISTS` -- there's only one schema version so far;
  add real migration machinery once there's an actual second version to
  migrate between, not before.

## Encryption key management

The SQLCipher passphrase is a random 32-byte key (`rand::rngs::OsRng`,
hex-encoded), stored in the OS keychain under the same service name as
account credentials, with a reserved sentinel "account" name
(`__local_cache_key__`) so it can't collide with a real `account_id`.

`get_or_create_cache_key` distinguishes `keyring::Error::NoEntry`
specifically from every other keychain error before deciding to mint a
new key. This matters: `credentials.rs`'s `get_credential` collapses every
error into a single `String`, which is fine for its callers, but here that
distinction is load-bearing. If a transient keychain failure (Secret
Service not running, a permissions hiccup) were treated the same as "no
key yet," it would silently generate and persist a brand new key,
permanently stranding any data already encrypted under the real one
behind a now-overwritten keychain entry. So `cache.rs` talks to
`keyring::Entry` directly rather than going through the `credentials.rs`
wrapper.

## Schema

One table so far:

```sql
CREATE TABLE cached_messages (
    account_id  TEXT NOT NULL,
    folder      TEXT NOT NULL,
    uid         INTEGER NOT NULL,
    subject     TEXT,
    from_addr   TEXT,
    date        TEXT,
    seen        INTEGER NOT NULL DEFAULT 0,
    flagged     INTEGER NOT NULL DEFAULT 0,
    body_text   TEXT,
    body_html   TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, folder, uid)
);
```

`upsert_summaries` and `upsert_body` each touch only their own half of the
row's columns on conflict (summary fields vs. body fields), so caching a
folder listing never clobbers a body fetched earlier for the same UID, and
vice versa.

## Used by the IMAP layer

`imap.rs`'s `fetch_messages` and `fetch_message_body` commands write
through to the cache after a successful fetch (`cache_summaries` /
`cache_body`). This is best-effort: a cache write failure is logged via
`log::warn!` and otherwise ignored, never turned into a user-visible
error. IMAP is still the source of truth for everything; the cache is a
local mirror that accumulates as a side effect of normal use.

## Stats and clearing

`cache_stats()` returns `{ message_count, size_bytes }` --
`message_count` is `SELECT COUNT(*) FROM cached_messages`, `size_bytes`
is the whole SQLCipher file's size on disk via `std::fs::metadata`
(accounts/contacts/PGP keys included, since that's what "how much disk
is this using" actually means). `clear_cache()` is `DELETE FROM
cached_messages` only -- deliberately not touching
`accounts`/`contacts`/`pgp_keys`/`pgp_contact_keys`, since those are
durable data the user wouldn't expect a "clear cache" button to destroy
(a PGP secret key in particular is unrecoverable once gone). Both are
real frontend-wired commands -- Settings > Data & Storage
(`src/components/DataStorageSettings.tsx`) shows the real numbers and a
real (confirm-before-destructive) Clear cache button.

## What this doesn't do yet

This is the storage layer only. Still unbuilt, each its own backlog item:

- **Offline reads.** Nothing currently reads from the cache -- there's no
  fallback path that serves cached rows when there's no network. The
  schema is shaped to support this later, but it isn't wired up.
- **Draft/outbox queue.** "Auto-send on reconnect" implies a queue table
  and retry logic, neither of which exist here.
- **Contact/address cache.** This one's actually done -- a `contacts`
  table exists and is wired into `fetch_message_body`/`send_message`,
  see `contacts.md`. Left here as a historical note that this list goes
  stale; check `backend-backlog.md` for the current source of truth.
- **Full-text search.** No FTS index; `cached_messages` is a plain table.
- **Attachment bytes.** `imap::fetch_attachment`/`pop3::pop3_fetch_attachment`
  download a specific attachment's bytes now (base64-encoded over IPC,
  addressed by its index in `fetch_message_body`'s attachment list), but
  nothing writes them here -- this table still has no attachment-content
  column, so a re-fetch re-downloads rather than reading a local copy.

## Verification

`cache.rs` has unit tests that exercise the real SQLCipher encryption (not
a mock): a round-trip through `upsert_summaries`/`upsert_body`, a check
that re-opening the same path with the same key preserves data across
connections, and a check that opening an existing cache with the wrong key
fails outright (proof the file is actually encrypted, not just an ignored
pragma). A separate test exercises `get_or_create_cache_key` against the
real OS keychain, same precedent as `credentials.rs`'s
`round_trips_through_the_real_os_keychain` -- not `#[ignore]`d, since this
dev environment is expected to have a working Secret
Service/Keychain/Credential Manager.
