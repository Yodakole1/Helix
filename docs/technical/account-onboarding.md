# Account onboarding

`src-tauri/src/account.rs` exposes `add_account(account_id, password,
display_name, imap_host, imap_port, smtp_host, smtp_port,
smtp_use_starttls, archive_folder, trash_folder)` — the command the
frontend's "add account" flow is meant to call. It ties credential
storage, the IMAP layer, and the local account list together so the
frontend never has to coordinate them itself:

1. Stores the password via `credentials::store_credential`
2. Verifies it actually works by calling `imap::list_folders` against
   `imap_host`/`imap_port`
3. Persists the rest of the connection metadata (no password) to the
   local encrypted cache via `cache::upsert_account` — see
   `multi-account.md` for the storage model this feeds into
4. If either the verification or the persistence step fails, deletes the
   just-stored credential and returns the error — onboarding shouldn't
   leave a broken, unverified, or unrecorded credential sitting in the
   keychain
5. On success, returns the `account_id` plus the folder list, so the UI
   has something real to show immediately after adding an account

`archive_folder`/`trash_folder` are optional, defaulting to
`"Archive"`/`"Trash"` if not supplied. SMTP credentials are not separately
verified at onboarding — only the IMAP login is checked, same as before
this command grew SMTP fields.

There's deliberately no "update account" or "test connection without
saving" command yet — those can get added once the frontend's onboarding
flow actually exists and it's clear what it needs. (Calling `add_account`
again for an existing `account_id` does work as a de facto update, since
`cache::upsert_account` is a true upsert — see `multi-account.md`.)

`list_accounts` and `remove_account` now exist alongside `add_account`
for listing and undoing onboarding — see `multi-account.md` for both.

## Verification

- `rolls_back_the_stored_credential_when_verification_fails` (`#[ignore]`,
  needs network) stores a bogus credential, calls `add_account` against
  `imap.gmail.com`/`smtp.gmail.com`, confirms the failure surfaces
  correctly, and confirms the credential is gone afterward — not left
  behind as a broken entry.
- The success path was manually verified against a real account on a real
  hosting provider (same one used in `imap-core.md`): `add_account`
  stored the credential, connected, persisted the account row, and
  `list_accounts` reflected it; `fetch_message_body` against a real
  message harvested a real contact via `search_contacts`; `remove_account`
  then confirmed both the keychain credential and the account row were
  gone. Not part of the committed test suite, for the same reason as the
  IMAP scratch checks — no contributor will have access to that account.

## Special-folder resolution (added later)

`add_account` no longer hardcodes "Sent"/"Trash"/"Archive"/"Drafts"/
"Spam" as the account's special folders. Those defaults silently broke
save-to-Sent and archive/trash moves on providers that nest mailboxes --
the real test host's layout is `INBOX.Sent`/`INBOX.Trash`/..., and an
APPEND to the literal "Sent" fails outright (verified live). The LIST
response from the verification login now feeds
`imap::resolve_special_folder`, which matches each role by the folder's
leaf name against the synonyms servers actually use ("Sent Mail",
"Deleted Items", "Junk", "All Mail", ...), preferring the least-nested
match; explicit caller-supplied folder overrides still win. Accounts
recorded before this existed are healed at runtime the first time an
APPEND or move fails -- see `folder-operations.md` and `smtp.md`.

## The onboarding flow is a tab (added later)

`AddAccountModal` was replaced by `src/components/AddAccountView.tsx`, a
full-page flow that opens as its own tab (or over the welcome screen for
the first account) instead of a blocking dialog. After the mail login
verifies, it probes CalDAV and CardDAV with the same credentials
(`discover_caldav`/`discover_carddav` against the mail domain, then the
IMAP host) and shows a per-service checkmark; Continue adds every
discovered calendar/address book (`add_caldav_source`/
`add_carddav_source`, best-effort) and opens the inbox. A failed probe is
reported ("do you want to continue with what worked?") and never blocks
mail -- mail is the gate: if the mail login fails, nothing is added.
