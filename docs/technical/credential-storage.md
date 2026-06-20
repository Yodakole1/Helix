# Credential storage

Account credentials (passwords, OAuth tokens) are stored in the OS's
native secure credential store, not in our own database. This keeps
secrets out of any file we control and out of the webview/JS side
entirely — only the Rust backend ever touches them.

## Implementation

`src-tauri/src/credentials.rs` wraps the [`keyring`](https://crates.io/crates/keyring)
crate behind three Tauri commands:

- `store_credential(account_id, secret)`
- `get_credential(account_id)`
- `delete_credential(account_id)`

Each credential is namespaced under the service name `dev.helix.app` with
`account_id` (the account's email address) as the username, so entries
don't collide with unrelated apps.

`store_credential` takes the secret by value and calls `.zeroize()` on it
right after attempting to store it (success or failure), so the plaintext
password doesn't linger in process memory any longer than that one
`set_password` call needs it for — same pattern used in the IMAP layer's
`login_with_stored_credential`.

## Backend per OS

The `keyring` crate ships with no backend enabled by default — the backend
is chosen explicitly per target in `src-tauri/Cargo.toml`:

| OS      | Feature               | Underlying store                                   |
|---------|------------------------|-----------------------------------------------------|
| Linux   | `sync-secret-service`  | Secret Service over D-Bus (gnome-keyring, KWallet)  |
| macOS   | `apple-native`         | Keychain Services                                   |
| Windows | `windows-native`       | Credential Manager                                  |

Linux note: this requires a running Secret Service provider. GNOME and KDE
both ship one (gnome-keyring, KWallet via ksecretservice); a bare window
manager without either won't have one available, and credential storage
will fail at runtime. Worth keeping in mind if Helix ever needs to run on
a minimal Linux setup — there's no fallback in place yet.

## Verification

`credentials.rs` has a test (`round_trips_through_the_real_os_keychain`)
that stores, reads, and deletes a real entry against whatever Secret
Service/Keychain/Credential Manager is available on the machine running
the test — it talks to the actual OS credential store, not a mock.

## Used by the IMAP layer

`src-tauri/src/imap.rs` is the first real consumer: `list_folders` and
`fetch_messages` take an `account_id` rather than a password, and resolve
the password via `get_credential` internally (see
`login_with_stored_credential` in `imap-core.md`). The retrieved password
is zeroized immediately after the login attempt, success or failure, so
it doesn't sit in process memory for longer than that single call needs
it.

## Used by account onboarding

`src-tauri/src/account.rs`'s `add_account` calls `store_credential`, then
verifies it by connecting through the IMAP layer, rolling the credential
back via `delete_credential` if verification fails. See
`account-onboarding.md`.
