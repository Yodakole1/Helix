# Account onboarding

`src-tauri/src/account.rs` exposes `add_account(account_id, password, host,
port)` — the command the frontend's "add account" flow is meant to call.
It ties credential storage and the IMAP layer together so the frontend
never has to coordinate them itself:

1. Stores the password via `credentials::store_credential`
2. Verifies it actually works by calling `imap::list_folders`
3. If verification fails, deletes the just-stored credential and returns
   the error — onboarding shouldn't leave a broken, unverified account
   sitting in the keychain
4. On success, returns the `account_id` plus the folder list, so the UI
   has something real to show immediately after adding an account

There's deliberately no "update account" or "test connection without
saving" command yet — those can get added once the frontend's onboarding
flow actually exists and it's clear what it needs.

## Verification

- `rolls_back_the_stored_credential_when_verification_fails` (`#[ignore]`,
  needs network) stores a bogus credential, calls `add_account` against
  `imap.gmail.com`, confirms the failure surfaces correctly, and confirms
  the credential is gone afterward — not left behind as a broken entry.
- The success path was manually verified against a real account on a real
  hosting provider (same one used in `imap-core.md`): `add_account`
  stored the credential, connected, returned 7 real folders, and the
  credential was confirmed present in the keychain afterward, then
  deleted as part of the scratch check. Not part of the committed test
  suite, for the same reason as the IMAP scratch checks — no contributor
  will have access to that account.
