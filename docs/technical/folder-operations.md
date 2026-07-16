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
- `subscribe_folder(account_id, host, port, folder)` — IMAP `SUBSCRIBE`
- `unsubscribe_folder(account_id, host, port, folder)` — IMAP `UNSUBSCRIBE`
- `list_subscribed_folders(account_id, host, port)` — IMAP `LSUB "*"`;
  returns the subset of folders the server considers subscribed for this
  account, as a `Vec<String>` of folder names

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
- **No recursive delete semantics guarantee.** `DELETE` behavior on a
  folder with child folders is server-defined (RFC 3501 §6.3.4); this
  passes the command through as-is rather than emulating a recursive
  delete.

## `list_folders` shows subscriptions, not the raw `LIST`

The sidebar calls `list_folders`, which now prefers `LSUB "*"` over the
raw `LIST` `collect_folder_names` used to return unconditionally (that
helper is still used internally for namespace detection). Hosting-provider
IMAP stacks (cPanel/Dovecot in particular) auto-create service mailboxes
the user never subscribed to — an unsubscribed spam-filter folder sitting
next to the real, subscribed Junk folder is the case that motivated this —
and a raw `LIST` dumps all of it into the sidebar, unlike every classic
desktop client (which shows subscriptions).

Three repairs sit on top of the bare `LSUB` result:

- **`INBOX` is prepended if missing.** Many servers never report INBOX
  itself as subscribed even though it's always selectable.
- **The account's recorded special folders are appended if unsubscribed.**
  Sent/Trash/Drafts/Archive/Spam disappearing from the sidebar would break
  every move/append flow that targets them by name, so `list_folders`
  reads `AccountRecord` from the cache and force-includes each one.
- **An empty `LSUB` falls back to the full `LIST`.** A server (or an
  account) with no subscriptions at all still needs a working sidebar
  rather than an empty one.

Because the sidebar is now subscription-driven, the folder-mutation
commands keep the subscription list in sync so folders don't appear to
vanish or get stuck:

- `create_folder` subscribes to the folder right after `CREATE` succeeds
  (`subscribe_created`, best-effort — the folder still exists even if the
  `SUBSCRIBE` fails, and the full-`LIST` fallback would still find it).
- `delete_folder` unsubscribes *before* attempting `DELETE`, since `DELETE`
  itself doesn't touch the subscription list and a dead subscription would
  otherwise leave a ghost entry in the `LSUB`-based sidebar forever. It
  also gained the same namespace-prefix retry `create_folder` already had:
  a bare name can be rejected on a server with an `INBOX.` namespace, so a
  failed `DELETE` retries against `detect_namespace_prefix`'s guess (and
  unsubscribes that prefixed name too).
- `rename_folder` moves the subscription from the old name to the new one
  after a successful `RENAME` (`fix_subscription_after_rename`) — RFC 3501
  leaves that up to the client, and skipping it would keep showing the old
  name and never show the new one. It also retries with a rebuilt
  namespaced target (source's parent path + the new leaf name) when the
  bare rename is rejected, since the rename UI only ever submits a leaf
  name.

All of these repairs are best-effort and logged to the debug log
(`crate::debug_log::record`) on failure rather than surfaced as a second
error — the primary CREATE/DELETE/RENAME result is what the caller acted
on and already got its own error path.

## Verification

These are thin pass-throughs to `async-imap`'s `create`/`delete`/`rename`/
`expunge`, so there are no pure unit tests for them — the logic worth
testing (`empty_folder`'s empty-mailbox guard, the `1:*` store) needs a
real server. A GreenMail round-trip test (create a folder, append
messages, empty it, assert it's empty; create/rename/delete and assert via
`list_folders`) is the natural coverage, following the `#[ignore]` pattern
in `imap-core.md`/`mailbox-actions.md`, and isn't written yet.

## Namespace-aware CREATE (added later)

Some providers (cPanel/Dovecot layouts in particular) nest every user
mailbox under the INBOX namespace and reject a bare `CREATE Projects`
with "Mailbox name should probably be prefixed with: INBOX." -- verified
against the real hosting-provider test mailbox. `create_folder` now
retries a failed CREATE with the detected namespace prefix:
`detect_namespace_prefix` looks at the LIST response, and if every
non-INBOX folder starts with `INBOX.` (or `INBOX/`), the retry creates
`INBOX.<name>`. Flat-layout servers are unaffected (first CREATE
succeeds, or no prefix is detected and the original error surfaces).

Related: destination folders for moves self-heal the same way -- see
`multi-account.md`'s special-folder resolution notes and
`imap::move_messages_with_heal`, which retries a failed move against
`resolve_equivalent_folder`'s match (leaf-name first, then special-folder
synonyms, e.g. a configured "Spam" healing to the server's
"INBOX.Junk") and persists the corrected name to the account record via
`persist_folder_correction`.
