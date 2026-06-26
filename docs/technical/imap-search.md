# IMAP server-side search

`src-tauri/src/imap.rs` exposes `search_messages`, which runs an IMAP
server-side `UID SEARCH` and returns summaries for the matches. Search
happens on the server, not over a locally-downloaded copy of the mailbox,
so it works across an entire folder without first fetching every message.

## Command

```
search_messages(account_id, host, port, folder, query, limit)
    -> Vec<MessageSummary>
```

`query` is matched as a substring of the message's **Subject, From, To, or
Body**. The folder is opened with `EXAMINE` (read-only) — searching must
never mark anything `\Seen`. Results are the newest `limit` matches,
highest UID first.

## How the criteria string is built

IMAP's `OR` search key is strictly binary — it takes exactly two search
keys. A four-field match is therefore a left-folded chain in prefix
notation (`build_search_criteria`, a pure function so it's unit-testable
without a server):

```
OR OR OR SUBJECT "q" FROM "q" TO "q" BODY "q"
```

The query is wrapped in an IMAP quoted string by `imap_quote`, which:

- escapes `\` and `"` (the only characters that need escaping inside a
  quoted string, per RFC 3501 §4.3), and
- strips `CR`/`LF` outright — a newline in the query would otherwise
  terminate the command line and let the remainder be interpreted as a
  separate IMAP command (command injection). This is tested directly
  (`imap_quote_strips_crlf_so_it_cannot_break_the_command_line`).

## Non-ASCII queries

A query containing any non-ASCII byte gets a `CHARSET UTF-8` prefix so the
server interprets the bytes as UTF-8. Pure-ASCII queries omit it, because
some servers reject an explicit `CHARSET` they consider redundant. This is
a deliberate "only add it when needed" choice rather than always sending
`CHARSET UTF-8` and hoping every server accepts it.

## Result handling

`UID SEARCH` returns an unordered set of UIDs. The command sorts them
descending (highest UID ≈ newest arrival), truncates to `limit` so a query
matching thousands of messages doesn't pull them all over IPC, then issues
one `UID FETCH (UID FLAGS ENVELOPE INTERNALDATE)` for that capped set —
reusing `summary_from_fetch`, the same envelope-to-`MessageSummary` mapping
`fetch_messages` uses. The fetched rows are re-sorted newest-UID-first
since the server may return them in any order.

## What this doesn't do

- **No structured/field-specific search from the frontend.** The command
  exposes one free-text query matched across four fields. Date-range,
  flag-state (`UNSEEN`, `FLAGGED`), or single-field searches aren't
  surfaced yet, though IMAP supports them and `build_search_criteria`
  could be extended.
- **No cross-folder ("all mail") search.** One folder per call. Searching
  every folder means calling this per folder and merging, which the
  frontend or a future command can layer on top.
- **No local/offline search.** This is purely server-side. The local
  cache has no full-text index (see `local-cache.md`), so offline search
  is a separate, unimplemented piece of work.

## Verification

Pure unit tests (no network), part of the default `cargo test` pass:

- `imap_quote_escapes_quotes_and_backslashes`
- `imap_quote_strips_crlf_so_it_cannot_break_the_command_line`
- `build_search_criteria_produces_a_four_way_or_chain`
- `build_search_criteria_escapes_the_query_in_every_field`

The live `UID SEARCH`/`UID FETCH` round-trip against a real server isn't
covered by an automated test yet — it needs a GreenMail container seeded
with messages whose Subject/From/Body are known, the same pattern as the
other `#[ignore]` IMAP tests in `imap-core.md`.
