# Mailbox mutation commands

`src-tauri/src/imap.rs` exposes commands that change mailbox state, unlike
`fetch_messages`/`fetch_message_body` which are read-only.

## Single-message commands

- `set_message_seen(account_id, host, port, folder, uid, seen)` — adds or
  removes `\Seen` via `UID STORE`
- `set_message_flagged(account_id, host, port, folder, uid, flagged)` —
  same shape, for `\Flagged` (the "star" action)
- `move_message_to_folder(account_id, host, port, folder, uid,
  destination_folder)` — moves one message into another folder

## Batch (multi-select) commands

The single-message commands above are thin wrappers over internal helpers
that already speak IMAP UID *sets*, so the batch variants are the same
operation over a `Vec<u32>` of UIDs instead of one — one `UID STORE`/MOVE
round-trip for the whole selection rather than one per message:

- `set_messages_seen(account_id, host, port, folder, uids, seen)` — mark a
  multi-selection read/unread
- `set_messages_flagged(account_id, host, port, folder, uids, flagged)` —
  star/unstar a multi-selection
- `move_messages_to_folder(account_id, host, port, folder, uids,
  destination_folder)` — move/archive a multi-selection, through the same
  three-tier MOVE/UIDPLUS/SEARCH strategy as the single-message move
- `mark_folder_seen(account_id, host, port, folder, seen)` — the "mark all
  as read" action: a `1:*` UID store across the whole folder in one shot.
  Short-circuits on an empty folder, since a `1:*` store errors on some
  servers when there's nothing to act on.

An empty `uids` list is an explicit error ("no messages selected"), not a
silent no-op — `join_uids` returns `None` and the command surfaces it,
since a STORE/COPY against an empty set is a caller bug worth catching.

Archive and Trash aren't separate commands. They're just the move command
with the account's actual archive/trash folder name as
`destination_folder` — those names vary by provider (`INBOX.Archive`,
`[Gmail]/All Mail`, `Deleted Items`, ...), and resolving "the" archive
folder for an account via the `SPECIAL-USE` extension (RFC 6154) is a
separate concern the frontend or a future command will need to handle, not
something baked into the move primitive itself.

All of these open the folder with `SELECT`, not `EXAMINE` — they exist
specifically to mutate state, unlike `fetch_messages`'s read-only
preview.

`MessageSummary` (returned by `fetch_messages`) now also reports
`flagged`, alongside the existing `seen`, sourced from the same `FETCH
FLAGS` request — no extra round trip. Without this, `set_message_flagged`
would be a write with no way for the frontend to read back current state.

## Why moving a message needs three different strategies

The natural way to move a message is the `MOVE` command (RFC 6851), but
it's an extension, not part of base IMAP4rev1 — plenty of real servers
don't implement it. `move_message` checks the server's advertised
capabilities and picks the best mechanism it actually supports:

1. **`MOVE` (RFC 6851)**, if the server advertises the `MOVE` capability.
   One round trip, atomic from the client's point of view.
2. **`UID COPY` + `UID STORE \Deleted` + `UID EXPUNGE`**, if the server
   lacks `MOVE` but supports `UIDPLUS` (RFC 4315). `UID EXPUNGE` removes
   exactly the UID set given to it, so this is safe even if some other
   message in the folder is independently marked `\Deleted`.
3. **A SEARCH-based dance**, for servers with neither extension. A bare
   `EXPUNGE` removes *every* `\Deleted` message in the folder, not just
   the one being moved — so if some other IMAP client had already marked
   a different message `\Deleted` and hadn't cleaned it up yet, a careless
   implementation would silently destroy it too. Instead: `COPY` the
   target, `SEARCH DELETED` to find any *other* already-deleted messages,
   temporarily clear their `\Deleted` flag, delete only the target UID,
   `EXPUNGE`, then restore the others' `\Deleted` flag. This is the exact
   sequence [RFC 3501's own `STORE`/`EXPUNGE` documentation describes](https://tools.ietf.org/html/rfc3501#section-6.4.6)
   for this situation — not a novel workaround. It's also not race-free:
   a message marked `\Deleted` by another client between the `SEARCH` and
   the `EXPUNGE` would still be lost. That window is inherent to not
   having UIDPLUS, not a bug in this implementation.

## A real finding from testing against a real host

The real professional mail host used elsewhere in these docs (see
`smtp.md`) supports *neither* `MOVE` nor `UIDPLUS` — confirmed by
checking its post-login `CAPABILITY` response directly:

```
('IMAP4REV1', 'LOGIN-REFERRALS', 'ID', 'ENABLE', 'IDLE', 'SASL-IR',
 'LITERAL+', 'AUTH=PLAIN', 'AUTH=LOGIN')
```

This is a real, currently-relevant case for the third (SEARCH-based)
strategy, not a hypothetical one. GreenMail, by contrast, advertises both
`MOVE` and `UIDPLUS`, so it can't exercise that code path at all — see
Verification below for how each tier actually gets tested.

## Verification

GreenMail advertises `MOVE` and `UIDPLUS`, so tiers 2 and 3 are tested by
calling their private helper functions directly rather than through
`move_message`'s capability check, which would otherwise always pick
tier 1 against GreenMail.

- `sets_and_clears_the_seen_flag_against_a_local_test_server` /
  `sets_and_clears_the_flagged_flag_against_a_local_test_server`
  (`#[ignore]`, need a local GreenMail container): each sets a flag,
  confirms it via `fetch_recent_messages`, clears it, confirms again.
  Needs the same single-message seed as `imap-core.md`'s
  `parses_a_real_message_from_a_local_test_server` (one plain-text
  message as UID 1):
  ```
  docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
    greenmail/standalone:2.1.0

  python3 - <<'EOF'
  import smtplib
  from email.mime.text import MIMEText
  from email.utils import formatdate

  msg = MIMEText("This is a test message body for Helix IMAP fetch testing.")
  msg["Subject"] = "Helix test message"
  msg["From"] = "Sender Name <sender@helix.test>"
  msg["To"] = "helix@helix.test"
  msg["Date"] = formatdate(localtime=True)

  with smtplib.SMTP("127.0.0.1", 3025, timeout=10) as smtp:
      smtp.sendmail("sender@helix.test", ["helix@helix.test"], msg.as_string())
  EOF

  cargo test -- --ignored

  docker rm -f helix-test-greenmail
  ```
- `moves_a_message_via_the_move_extension_on_a_local_test_server`
  (`#[ignore]`, same seed as above): calls `move_message` itself, so this
  also proves the capability check actually prefers `MOVE` when it's
  available, not just that `uid_mv` works in isolation. Asserts the
  message is gone from `INBOX` and present in a freshly-created `Archive`
  folder.
- `moves_a_message_via_the_uidplus_fallback_on_a_local_test_server`
  (`#[ignore]`, same seed): calls `move_via_copy_store_uid_expunge`
  directly to exercise tier 2's mechanics specifically.
- `moves_a_message_via_the_search_fallback_without_losing_other_deleted_messages_on_a_local_test_server`
  (`#[ignore]`): the important one for tier 3. Needs two seeded messages
  (UIDs 1 and 2) instead of one:
  ```
  docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
    greenmail/standalone:2.1.0

  python3 - <<'EOF'
  import smtplib
  from email.mime.text import MIMEText
  from email.utils import formatdate

  def send(subject, body):
      msg = MIMEText(body)
      msg["Subject"] = subject
      msg["From"] = "Sender Name <sender@helix.test>"
      msg["To"] = "helix@helix.test"
      msg["Date"] = formatdate(localtime=True)
      with smtplib.SMTP("127.0.0.1", 3025, timeout=10) as smtp:
          smtp.sendmail("sender@helix.test", ["helix@helix.test"], msg.as_string())

  send("Helix test message 1", "First message, UID 1.")
  send("Helix test message 2", "Second message, UID 2.")
  EOF

  cargo test -- --ignored

  docker rm -f helix-test-greenmail
  ```
  The test marks UID 2 `\Deleted` first (standing in for a message some
  other client left in that state), moves UID 1 via
  `move_via_search_store_expunge`, then asserts UID 2 is still present in
  `INBOX` afterward *and* still has `\Deleted` set — proving the dance
  both avoided destroying it and correctly restored its flag, not just
  that the target message moved.
- Manually verified against the real professional mail host's actual
  tier-3 path: appended a disposable test message directly to `INBOX`
  via `APPEND` (sending through `send_message` wasn't an option — this
  host's SMTP service has the certificate mismatch documented in
  `smtp.md`), called `move_message_to_folder` for real with destination
  `INBOX.Archive`, confirmed over IMAP that the message landed in
  `INBOX.Archive` and that `INBOX` had no message left with `\Deleted`
  set, then deleted the test message for real. Not part of the committed
  suite, for the same reason as the other real-host checks in these
  docs — other contributors won't have access to that account.
