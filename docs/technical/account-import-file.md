# Bulk account import from a file

`src-tauri/src/account_import.rs` -- the `import_accounts_file(path)`
command behind the "Import accounts from a file..." button on the
add-account page. It exists for the person provisioning many mailboxes at
once (typically on their own domain): instead of clicking through the
onboarding form per address, they fill in a plain-text file, point Helix
at it, and get a per-account verdict list back. The committed
`accounts-import.example.txt` at the repo root is the template users copy;
a filled-in `accounts-import.txt` is gitignored so it can never be
committed by accident.

## File format

`key: value` lines (a `=` separator is accepted too), one block per
account, blocks separated by blank lines or a `---` divider, `#`/`;`
comment lines. Keys are case-insensitive and `-` is treated as `_`.

| Key | Required | Notes |
| --- | --- | --- |
| `email_address` | yes | Aliases: `email`, `address`, and the misspelling `email_adress` -- rejecting an otherwise-valid file over one missing letter helps nobody. |
| `password` | yes | Goes straight to the OS keychain via the normal add-account path; never persisted anywhere else. |
| `display_name` | no | Alias: `name`. |
| `imap_host` / `imap_port` / `imap_starttls` | no | Port defaults to 993, or 143 with `imap_starttls: on`. |
| `pop3_host` / `pop3_port` | no | Port defaults to 995. POP3S only, like the rest of `pop3.rs`. |
| `smtp_host` / `smtp_port` / `smtp_starttls` | see below | Port defaults to 465, or 587 with `smtp_starttls: on`. |
| `caldav_state` / `carddav_state` | no | `on`/`off` (also `true`/`yes`/`1` etc.). Alias: `caldav`, `carddav`, `contacts_state`. |

OAuth accounts (Gmail/Microsoft 365 via the sign-in buttons) can't be
imported from a file -- there's no password to write down, and each one
needs its own interactive browser consent. The parser has no key for
them, so a typoed attempt fails loudly like any other unknown key.

Server settings are all-or-nothing, mirroring `discovery.rs`'s posture: a
block either names no servers at all -- then IMAP+SMTP are resolved from
the address via `discovery::discover_server_config` at import time -- or
it names both the incoming server (`imap_host` **or** `pop3_host`, not
both) and `smtp_host`. A dangling `imap_port` without its host, an
unknown key, a duplicated key, a bad port, or the same address in two
blocks are all hard parse errors with a line number: a file full of
passwords deserves loud errors over silent guesses.

## What an import does

The whole file is parsed and validated up front; only then does any
network or keychain work start, so a syntax error costs nothing. Each
parsed account then runs **the same code the onboarding form runs** --
`account::add_account` / `account::add_pop3_account` directly, so the
store-verify-persist-or-roll-back discipline, special-folder resolution,
and every other onboarding property apply unchanged. Accounts import
independently and sequentially: one wrong password makes that row
`failed` in the report, it doesn't abort the run. An address that's
already configured is `skipped`, not overwritten.

`caldav_state: on` / `carddav_state: on` reproduce the form's services
step: discover against the mail domain first (RFC 6764 .well-known), then
the mail server, and add every calendar/address book found via the normal
`add_caldav_source`/`add_carddav_source`. This is best-effort by design --
a mailbox that verified fine must not read as "failed" because the
provider has no calendar -- so DAV problems land as notes on an `added`
row. The DAV modules are blocking (`reqwest::blocking`), so these calls
run under `tokio::task::spawn_blocking` rather than stalling the shared
async runtime.

The command returns `ImportAccountsReport`: one
`{ email, status: added|skipped|failed, detail, calendars_added,
address_books_added }` row per block, plus the file-deletion outcome.

## The file is deleted afterwards

The import file is a plaintext password list, so after the run (whether
individual accounts succeeded or not) it is overwritten with zeros,
fsynced, and unlinked. The overwrite is best-effort scrubbing, not a
forensic guarantee -- journaling filesystems, SSD wear leveling, and
copy-on-write can all keep stale blocks -- but it beats leaving the list
in Downloads. Two deliberate exceptions:

- **Parse failure**: nothing was imported, and deleting the file would
  throw away the user's typing over a typo. The file stays, and the error
  message says so explicitly (including that it still contains
  passwords).
- **Deletion failure** (permissions, file moved mid-run): the report
  carries `file_deleted: false` plus the error, and the frontend tells
  the user to delete the file by hand.

There's also a 1 MiB size cap -- a filled-in import file is a few
kilobytes, so anything bigger is a mispicked file (an mbox, a log) that
shouldn't be slurped into memory we'd then have to zeroize. Speaking of
which: the in-memory file contents are zeroized right after parsing, and
each parsed password is zeroized when its account spec drops.

## Frontend

`importAccountsFile` in `src/lib/account.ts`; the UI lives at the bottom
of `AddAccountView`'s form step (file picked via the dialog plugin, same
as mail import). The result list renders one line per account -- green
for `added` (with calendar/address-book counts), amber for
`skipped`/`failed` with the reason -- and an "Open inbox" button appears
once at least one account landed, which fires the same `onDone` path as
the form (the remaining imported accounts arrive via the account-list
reload that triggers).

## Tests

The parser and the delete helper are pure/local, so they're covered by
plain unit tests in the default `cargo test` run: block splitting,
comments, CRLF, `=` separators, key aliases (including `email_adress`),
STARTTLS-dependent port defaults, and the full set of rejection cases
(unknown/duplicate keys, missing password, both hosts, half-specified
servers, bad ports/flags, duplicate addresses). The verify-and-store path
is `account.rs`/`pop3.rs` code with its own GreenMail-based coverage --
see `account-onboarding.md` and `pop3.md`.
