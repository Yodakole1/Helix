# Spam / junk workflow

`account::report_spam` moves a message to the account's configured spam
folder and tags it with the IMAP `$Junk` keyword so a server-side
Bayesian filter (if the server has one) can learn from the move.

## Command

```
report_spam(account_id, host, port, folder, uid) -> ()
```

- Resolves `spam_folder` from the stored `AccountRecord` (default `"Spam"`;
  configurable at `add_account` / `add_pop3_account` time or via
  `update_account`).
- Applies `$Junk` via `imap::set_message_keyword` first (best-effort:
  logged and ignored if the server rejects it, since many servers don't
  support custom keywords).
- Moves the message via `imap::move_message_to_folder` using the full
  three-tier MOVE/UIDPLUS/SEARCH fallback strategy (`mailbox-actions.md`).
- Returns an error only if the move itself fails (e.g. the spam folder
  doesn't exist).

## Account configuration

`AccountRecord` gained a `spam_folder: String` field (default `"Spam"`),
parallel to `archive_folder` and `trash_folder`. It's stored in the
`accounts` table via an additive `ALTER TABLE` migration (so existing
accounts automatically get the `"Spam"` default), and included in
`upsert_account` / `list_accounts` / `get_account`. `add_account` accepts
an optional `spam_folder` parameter to override the default at onboarding.

## What this doesn't do yet

- **Not spam / train ham** — there's no `report_not_spam` command yet.
  Moving a message *out* of the spam folder and clearing `$Junk` (setting
  `$NotJunk`) is the counterpart; it's a small addition once the frontend
  "Mark as not spam" button exists.
- **POP3 accounts** — `report_spam` is IMAP-only; POP3 has no flag commands.
  Moving a POP3 message to spam would be a `delete_message` on the POP3 side
  (POP3 has no folders to move between).
- **Bayesian local classifier** — see the per-feature docs in `docs/technical/`. The `$Junk`
  tagging is the hook for server-side filters; a client-side bag-of-words
  model is a separate backlog item.

## Verification

Covered by the existing `move_message_to_folder` tests (`mailbox-actions.md`)
plus the `imap::set_message_keyword` path. No dedicated unit test (it requires
a live IMAP server to verify the `$Junk` keyword round-trips), and the
GreenMail container test for moves already exercises the move path.
