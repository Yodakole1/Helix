# Folder operations

`src-tauri/src/imap.rs` exposes commands for managing the mailbox folder
structure itself, alongside the per-message commands in
`mailbox-actions.md`. These complement `list_folders` (which only reads
the folder list) with the ability to change it.

## Commands

- `create_folder(account_id, host, port, folder)` — IMAP `CREATE`
- `delete_folder(account_id, host, port, folder)` — IMAP `DELETE`
- `rename_folder(account_id, host, port, folder, new_name)` — IMAP `RENAME`
- `empty_folder(account_id, host, port, folder)` — permanently removes
  every message in a folder (the "empty trash" / "empty spam" action)

Each opens its own connection, runs the one command, and logs out — the
same open-per-command pattern as the rest of the backend (see
`CLAUDE.md`'s note on why there's no connection pooling).

## `empty_folder` vs. `move_message_to_folder`'s careful expunge

`empty_folder` is deliberately blunt: it `SELECT`s the folder, marks every
message `\Deleted` with a `1:*` UID store, then `EXPUNGE`s. Unlike
`move_message`'s SEARCH-based fallback — which goes to real trouble to
preserve *other* clients' `\Deleted` state so it expunges only the one
message being moved — there's nothing to preserve here: the whole folder
is being emptied regardless, so a plain `EXPUNGE` of everything is exactly
the intent.

The one guard: a `1:*` store against an **empty** mailbox errors on some
servers, so `empty_folder` checks `mailbox.exists == 0` after `SELECT` and
returns early rather than issuing a no-op store on a folder that's already
empty.

## What this doesn't do

- **No `SPECIAL-USE` resolution.** `empty_folder` takes a literal folder
  name; it doesn't know which folder *is* the trash for an account. That's
  the same boundary `move_message_to_folder` draws — resolving the
  account's actual Trash/Junk folder (via RFC 6154 `SPECIAL-USE`, or the
  names stored on `AccountRecord`) is the caller's job.
- **No subscription management.** IMAP `SUBSCRIBE`/`UNSUBSCRIBE` (which
  control whether a folder shows up in `LSUB`) aren't exposed; `CREATE`
  here doesn't auto-subscribe.
- **No recursive delete semantics guarantee.** `DELETE` behavior on a
  folder with child folders is server-defined (RFC 3501 §6.3.4); this
  passes the command through as-is rather than emulating a recursive
  delete.

## Verification

These are thin pass-throughs to `async-imap`'s `create`/`delete`/`rename`/
`expunge`, so there are no pure unit tests for them — the logic worth
testing (`empty_folder`'s empty-mailbox guard, the `1:*` store) needs a
real server. A GreenMail round-trip test (create a folder, append
messages, empty it, assert it's empty; create/rename/delete and assert via
`list_folders`) is the natural coverage, following the `#[ignore]` pattern
in `imap-core.md`/`mailbox-actions.md`, and isn't written yet.
