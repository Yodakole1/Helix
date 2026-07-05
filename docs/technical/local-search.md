# Local full-text search

`src-tauri/src/cache.rs` exposes `search_local_messages`, a full-text search
that runs entirely against the local encrypted cache — no network, no live
IMAP session. It is the offline, cross-folder, cross-account counterpart to
`imap.rs`'s server-side `search_messages` (see `imap-search.md`), and the
piece the product spec's "global search via local SQLite/FTS" line asked
for.

## Command

```
search_local_messages(account_id: Option<String>, query, limit)
    -> Vec<LocalSearchResult>
```

- `account_id = Some(..)` scopes the search to one account.
- `account_id = None` searches **every cached account at once** — the
  unified/global search.
- `LocalSearchResult` carries `account_id`/`folder`/`uid` (so the frontend
  knows where a hit lives and can open it) plus
  `subject`/`from`/`date`/`seen`/`flagged`. Unlike `MessageSummary`, which is
  implicitly scoped to a known account+folder by its caller, a global search
  spans both, so each result names its own location.
- The search spans **both IMAP and POP3** cached mail. A POP3 hit sets the
  `uidl` field (its stable open key — POP3 has no IMAP UID), carries the
  last-seen message `number` in `uid` for a live RETR, and reports
  `folder = "INBOX"` (POP3's single implicit mailbox); an IMAP hit leaves
  `uidl` `None`. The frontend distinguishes the two by `uidl` being present.

Results are the newest `limit` matches, ordered by date descending to match
the rest of the app rather than by FTS relevance rank. The IMAP and POP3
indexes are queried separately (each over its own FTS table) and the two
result streams are merged, re-sorted by date, and truncated to `limit`.

## What it searches

`query` is matched against each message's **Subject, From, and Body**. It
does **not** match To: `cached_messages` stores `from_addr` but no recipient
columns, so there's nothing local to index there. (The server-side search
does cover To, because the server has the full message.) Coverage is also
bounded by what's been cached — a message only becomes findable locally once
its summary (and, for body matches, its body) has been fetched at least once.
The index therefore grows as the user reads mail.

## How it's built

A standalone **FTS5** virtual table, `messages_fts`, lives in the same
SQLCipher database as everything else (`cache.rs`):

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    account_id UNINDEXED,
    folder     UNINDEXED,
    uid        UNINDEXED,
    subject,
    from_addr,
    body_text
);
```

FTS5 is compiled into the bundled SQLCipher build
(`-DSQLITE_ENABLE_FTS5`), so no extra dependency is needed.

It is a **standalone** table, not an FTS5 *external-content* table. The
external-content variant (which stores only the inverted index and reads the
text back from `cached_messages`) was tried first and abandoned: on this
SQLCipher build, both its `'rebuild'` command and bulk
`INSERT ... SELECT` produced index rows whose tokens came back empty, so
`MATCH` found nothing. The standalone table keeps its own copy of the
indexed text (a modest duplication, all inside the one encrypted file) and
indexes reliably. The `account_id`/`folder`/`uid` columns ride along
`UNINDEXED` so a hit can be located without a join — though the command still
joins back to `cached_messages` for the `date`/`seen`/`flagged` display
fields.

### Staying in sync with `cached_messages`

Three triggers, keyed by `cached_messages.rowid`, mirror every write:

- `cached_messages_fts_ai` (AFTER INSERT) — index the new row.
- `cached_messages_fts_ad` (AFTER DELETE) — `DELETE FROM messages_fts WHERE
  rowid = old.rowid`. This is what keeps `clear_cache` (a bulk
  `DELETE FROM cached_messages`) and account removal from leaving orphaned
  index entries.
- `cached_messages_fts_au` (AFTER UPDATE) — delete the old index row, insert
  the new one, so a re-fetch that changes a subject or fills in a body
  re-indexes correctly.

This stays correct only because every write to `cached_messages` goes through
ordinary SQL; nothing writes the FTS table directly except these triggers and
the one-time backfill.

### Backfill for pre-existing caches

The triggers only fire on writes made *after* they exist, so a cache that
predates this index would otherwise stay empty until every message happened
to be re-fetched. `backfill_fts_if_empty` (called from `open_at`) handles the
one-time migration: if the index is empty but `cached_messages` isn't, it
does a single `INSERT INTO messages_fts(...) SELECT ... FROM cached_messages`.
The empty-index guard means it's a no-op on a fresh install (both tables
empty) and runs at most once on an upgraded one (afterwards the index is
non-empty and it's skipped).

### POP3 mirror

POP3 mail lives in its own `cached_pop3_messages` table (keyed by UIDL, not
folder/uid — see `pop3.md`/`local-cache.md`), so it gets a parallel FTS5
table `pop3_messages_fts` with the same three sync triggers (keyed by
`cached_pop3_messages.rowid`) and its own one-time `backfill_pop3_fts_if_empty`.
`search_cached_messages` queries both indexes and merges the results. The
two are kept separate rather than unified into one FTS table because the
content tables they track have different shapes (POP3 has `uidl`/`number`
where IMAP has `folder`/`uid`).

## How the query string is built

`build_fts_query` (a pure function, unit-tested) turns free text into a safe
FTS5 `MATCH` expression. FTS5 treats bare words like `AND`/`OR`/`NOT`/`NEAR`
as operators and `"*():^-` as punctuation, so a raw user string can error out
or mean something unintended. The transform:

- splits on whitespace,
- quotes each token as a literal phrase, doubling any embedded `"` (FTS5's
  escaping rule), and
- appends `*` to each token so it's a **prefix** match — friendlier for
  search-as-you-type.

Tokens are space-joined, which FTS5 reads as an implicit AND, so every term
must appear. `build_fts_query("hello world")` becomes `"hello"* "world"*`.
An empty/whitespace-only query yields `None`, and the command returns no
results rather than running a malformed `MATCH`.

## What this doesn't do

- **No To-field match** (no recipient columns cached, as above).
- **No structured/field-specific or date-range search** — one free-text
  query across three fields, same surface as the server-side search.
- **No relevance ranking** — ordered newest-first, not by FTS5 `rank`/
  `bm25()`. The plumbing is there to switch later if wanted.
- **Doesn't fetch anything** — it only sees what's already cached, so its
  coverage is exactly the cache's coverage.

## Structured filters

`search_local_messages` (and the inner `search_cached_messages_filtered`)
accept structured filter params in addition to the free-text `query`:

| param | type | behavior |
|---|---|---|
| `from_filter` | `Option<String>` | `from_addr LIKE '%value%'` |
| `subject_filter` | `Option<String>` | `subject LIKE '%value%'` |
| `has_attachment` | `Option<bool>` | reserved (no cache column yet) |
| `is_unread` | `Option<bool>` | `seen = 0` (true) or `seen = 1` (false) |
| `is_flagged` | `Option<bool>` | `flagged = 1` (true) or `flagged = 0` (false) |
| `date_after` | `Option<String>` | `date >= value` (RFC 3339) |
| `date_before` | `Option<String>` | `date <= value` (RFC 3339) |

Two execution paths depending on whether `query` is non-empty:

- **FTS + filters**: filters are additional WHERE clauses on the JOIN side
  of the FTS5 query, not MATCH criteria. The FTS index stays fast; flag
  and date comparisons run against the regular indexed columns.
- **Filter-only** (empty `query`): the FTS step is skipped entirely and
  filters run against `cached_messages` directly via a plain SELECT. The
  command returns nothing if neither query nor filters are supplied, to
  avoid a full-cache scan.

POP3 results skip `is_unread`/`is_flagged` (POP3 has no server-side flags
in the cache schema) but support `date_after`/`date_before` and the
from/subject LIKE filters.

## Verification

Pure/local unit tests, part of the default `cargo test` pass (no network or
container needed — same as the rest of the `cache.rs` suite, which runs
against a temp-dir SQLCipher file via `open_at`):

- `build_fts_query_quotes_tokens_and_handles_empties`
- `local_search_matches_subject_from_and_body_across_folders`
- `local_search_scopes_to_one_account_when_asked`
- `local_search_index_follows_updates_and_deletes` (re-index on update, and
  that `clear_cache` empties the index)
- `local_search_backfills_index_for_a_preexisting_cache` (simulates an
  upgrade by dropping the triggers, inserting, then reopening)
