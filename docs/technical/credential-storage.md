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
`cache.rs` has an analogous keychain-backed test for the local cache's
encryption key (see "Also used by the local cache" below).

Selecting the right `keyring` feature per OS in `Cargo.toml` only proves
the code *should* work on all three platforms — it doesn't prove it
*does*, since none of this is exercised on anything but whatever OS the
developer happens to run (Linux, in this project's day-to-day
development). There is no CI workflow yet to close that gap: a 3-OS
matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`) running `cargo
test` on every push/PR, with the real-keychain round-trip test executing
against real Secret Service, real Keychain Services, and real Credential
Manager, is the natural way to get that coverage (Linux runners would
need a throwaway `gnome-keyring`/D-Bus session via `dbus-run-session`,
since they don't have one running by default the way a real desktop
session does; macOS/Windows runners already have a working default
keychain / Credential Manager with no extra setup needed) — but it isn't
written yet, so Windows/macOS credential storage is currently unverified
outside of manual testing on those platforms.

## Consumers

Every module that needs a mail/DAV password goes through these same three
commands — there is no second, ad hoc credential path anywhere in the
codebase:

- **IMAP/POP3/SMTP** (`imap.rs`, `pop3.rs`, `smtp.rs`): `list_folders`,
  `fetch_messages`, `send_message`, and friends take an `account_id`
  rather than a password, resolving it via `get_credential` internally
  (see `login_with_stored_credential` in `imap-core.md`) and zeroizing it
  immediately after the connection attempt, success or failure.
- **Account onboarding and updates** (`account.rs`): `add_account` calls
  `store_credential`, verifies it by actually connecting, and rolls it
  back via `delete_credential` if verification fails (see
  `account-onboarding.md`). `update_account`'s password-rotation path
  keeps the old password only long enough to restore it on a failed
  re-verification, zeroizing it on every exit path either way.
- **CalDAV/CardDAV** (`caldav.rs`, `carddav.rs`): each source's Basic-Auth
  password is stored under its own keychain key (`caldav__{id}` /
  `carddav__{id}`), not alongside the source's other metadata in the
  SQLCipher cache — see `caldav.md`/`carddav.md`.

## Also used by the local cache's encryption key

`cache.rs` uses this exact same `keyring::Entry` mechanism (not a second,
parallel implementation) to store the random 32-byte key that encrypts the
whole local SQLCipher mail cache, under the reserved account name
`__local_cache_key__`. This means the entire local cache's
encryption-at-rest is transitively protected by whatever secure store this
doc describes for each OS — there's no separate, weaker storage path for
that key. `get_or_create_cache_key_for` distinguishes `keyring::Error::NoEntry`
from every other keychain error before deciding to mint a new key, so a
transient keychain failure (Secret Service not running, a permissions
hiccup) can never look like "first run" and silently strand data already
encrypted under the real key. See `local-cache.md`.

## Known per-OS considerations

- **Windows Credential Manager caps a generic credential's blob at 2560
  bytes.** Nothing stored today gets close to that (mail/DAV passwords,
  and the cache key's 64-character hex string), but it's worth checking
  before ever routing something larger — a PGP secret key or an S/MIME
  PKCS#12 blob, say — through `store_credential` rather than the
  SQLCipher cache tables those actually live in today.
- **macOS Keychain access can prompt per build during development.**
  Keychain ACLs are tied to the app's code signature; an unsigned or
  ad-hoc-signed development build can look like a "new app" to the
  Keychain on each rebuild, triggering a repeated access-confirmation
  dialog. This is a development-experience wrinkle, not a security gap —
  a properly signed and notarized release build doesn't have this
  problem.
- **Linux requires a running Secret Service provider** (see above) — this
  is the one platform where credential storage can simply be unavailable
  on a correctly-installed system, if the desktop environment doesn't ship
  gnome-keyring or KWallet's Secret Service.
