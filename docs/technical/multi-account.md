# Multi-account model

How Helix identifies and stores multiple mail accounts, and how a
unified inbox view differs from a single-account one.

## Storage

Account metadata (display name, IMAP/SMTP host and port, STARTTLS flag,
archive/trash folder names) lives in an `accounts` table in the same
SQLCipher-encrypted local cache used for mail (`src-tauri/src/cache.rs`,
see `local-cache.md`). Putting it there rather than in a separate config
file means it gets the same at-rest encryption as cached mail, without a
second storage mechanism to keep secure. The password never goes in this
table -- it stays keychain-only, the same as before this table existed.

`cache::AccountRecord` is the row shape; `cache::upsert_account`,
`cache::list_accounts`, and `cache::delete_account` are the CRUD
functions. `upsert_account` is a true upsert (`ON CONFLICT(account_id) DO
UPDATE`) so re-running onboarding for the same address (e.g. to correct a
mistyped host) updates the row in place rather than erroring, while
`created_at` is only set on the initial insert and otherwise left alone.

## `account.rs` commands

- **`add_account`** now takes the full set of connection metadata
  (`display_name`, `imap_host`, `imap_port`, `smtp_host`, `smtp_port`,
  `smtp_use_starttls`, optional `archive_folder`/`trash_folder` defaulting
  to `"Archive"`/`"Trash"`), in addition to `account_id`/`password`. The
  flow is the same shape as before, with one more step:
  1. `credentials::store_credential`
  2. `imap::list_folders` to verify the password actually works (IMAP
     only -- SMTP credentials are taken on faith at onboarding, not
     separately verified; this is an existing limitation, not a new one)
  3. `cache::upsert_account` to persist the metadata
  4. Roll back the stored credential if *either* step 2 or step 3 fails --
     onboarding must never leave a broken, unverified, or unrecorded
     credential sitting in the keychain.
- **`list_accounts`** -- every stored account's metadata, no secrets.
- **`remove_account`** -- deletes the keychain credential and the
  account's row + cached mail (`cache::delete_account`, which removes
  matching `cached_messages` rows in the same transaction). The keychain
  deletion is checked and propagated; cache cleanup failing is logged and
  not treated as a command failure, the same posture as cache writes
  elsewhere.

- **`add_pop3_account`** -- onboards a POP3 account: store credential,
  verify via `pop3::verify_login` (connect + login + `QUIT` -- POP3 has no
  folders to list, so a clean login is the whole check), persist with
  `incoming_protocol = "pop3"`, `pop3_host`/`pop3_port` set, and the
  `imap_*` columns left as empty placeholders. Same store-verify-persist-
  or-roll-back discipline as `add_account`. SMTP is configured the same way
  (POP3 accounts still send over SMTP).
- **`update_account`** -- the credential-rotation / server-migration
  counterpart that lets a user change a password or host/port without the
  remove-and-re-add that would lose the account's cached mail and PGP
  identity. `password` is optional: `Some` rotates the keychain credential,
  `None` leaves it untouched. The new settings are re-verified *before*
  they're committed (over IMAP or POP3, matching the account's
  `incoming_protocol`), and a rotated password that fails verification is
  rolled back to the previously-working one -- a failed update never locks
  the user out of an account that worked a moment ago.

### Account record fields

`AccountRecord` gained `imap_use_starttls` (port-143-style STARTTLS vs.
implicit TLS on 993, mirroring the existing `smtp_use_starttls`),
`incoming_protocol`, `pop3_host`, and `pop3_port`. All are additive
`ALTER TABLE` migrations (`incoming_protocol` defaults to `'imap'`), so an
existing cache upgrades in place. The IMAP data commands resolve an
account's STARTTLS setting from this record at login time
(`imap::login_for_account`), so their signatures didn't change -- only
onboarding/verification passes the flag explicitly, since the account
isn't persisted yet at verify time.

## Unified vs. siloed inbox

**Siloed** (single account) is unchanged: call `imap::fetch_messages`
with one specific `account_id`.

**Unified** (every account, merged) is `account::fetch_unified_inbox(limit)`:

1. `cache::list_accounts()` for every stored account and its connection
   details.
2. Fan out with `futures::future::join_all`, once per account, **over the
   account's own protocol**: an IMAP account goes through the existing
   `imap::fetch_messages(account_id, imap_host, imap_port, "INBOX", limit)`,
   a POP3 account through `pop3::list_messages(account_id, pop3_host,
   pop3_port)` with each `Pop3MessageSummary` adapted to the shared
   `MessageSummary` shape (`pop3_summary_to_message_summary` -- the POP3
   `number` carried in `uid` so the frontend can RETR it, no flags, since
   POP3 has none). Either path reuses the exact same call a siloed fetch
   takes (cache write-through included) instead of a separate code path.
   POP3 has no `EXAMINE`-style server-side fetch window, so its fan-out
   lists the whole inbox and `limit` is applied in the merge (step 4); for
   a very large POP3 mailbox that's a real per-message header scan.
3. An account whose fetch fails (bad password, unreachable server) is
   logged via `log::warn!` and skipped, not allowed to fail the whole
   call -- one dead account shouldn't blank out everyone else's inbox.
4. Surviving results are tagged with their `account_id`
   (`UnifiedMessageSummary`, `#[serde(flatten)]`-ed so the wire shape
   stays flat), sorted newest-first, and truncated to `limit` overall.

   The frontend tells a POP3 row from an IMAP one by the row's `account_id`
   (it already knows each account's `incoming_protocol`), which is also how
   it knows to open that message via `pop3::fetch_message` (by the `uid`,
   which for POP3 is the message number) rather than `imap::fetch_message_body`.

Sorting parses each `date` with `DateTime::parse_from_rfc3339` instead of
comparing the raw strings. `MessageSummary.date` preserves each message's
original UTC offset rather than normalizing it (it's `internal_date()
.to_rfc3339()`), so two accounts on servers in different timezones would
sort incorrectly under a plain string comparison -- `"09:30:00+01:00"`
string-sorts after `"09:00:00+00:00"` even though the first happened
earlier. Messages with a missing or unparseable date sort last rather
than landing in an arbitrary position. This merge/sort/truncate step
(`merge_and_sort_summaries`) is deliberately pure and synchronous, split
from the network fan-out, so it has direct unit tests with no real IMAP
connection involved.

There's no separate "fetch every folder from every account" command --
unified currently means unified *INBOX*, matching what "unified inbox"
usually means in other mail clients. Extending it to other folders would
mean deciding what a cross-account "Archive" or "Sent" view even means
when folder names differ per provider; not addressed here.

## Frontend wiring

`AddAccountModal` (`src/components/AddAccountModal.tsx`) calls the real
`add_account` -- auto-resolving IMAP/SMTP host+port from the email's
domain via `discover_server_config` (`src/lib/discovery.ts`) unless the
user expands "advanced" and enters them manually. Settings > Accounts
renders the real, persisted list via `ConnectedAccountsSettings.tsx`
(`list_accounts`, with a real "Remove" calling `remove_account`). This is
the one place in the frontend with a real, persisted account list --
everything else (Sidebar, MessageList, ReaderPane, the active-account
concept in `App.tsx`) still reads the hardcoded sample `ACCOUNTS` array
in `src/data/accounts.ts`, so an account added this way doesn't yet show
up anywhere else in the app. See the per-feature docs in `docs/technical/`.

## What this doesn't do yet

- `add_account` doesn't verify SMTP credentials, only IMAP (POP3 accounts
  likewise verify only the incoming POP3 login, not SMTP).
- No multi-folder unified view, only INBOX.
- `fetch_unified_inbox` skips POP3 accounts -- it fans out over IMAP
  `INBOX`es, and POP3 has no folder/UID model to merge in (see `pop3.md`).
- `update_account` doesn't expose editing a POP3 account's `pop3_host`/
  `pop3_port` yet -- it preserves them and edits the shared connection
  fields only.
- No live update/IDLE for the unified view -- it's a one-shot fetch, same
  as every other fetch command today.
