# App lock

An optional lock screen shown once per app start, cleared by a password, a
FIDO2 security key (passkey), or both -- whichever the user has enrolled in
Settings > Privacy & Security. With neither enrolled, Helix opens straight
to the mailbox. Unlocking lasts for the app session; there is no re-lock
timer, deliberately -- the requested behavior is "unlock once after the
machine boots", not "type a password every time you glance at your inbox".

Backend module: `src-tauri/src/lock.rs`. Frontend: `src/lib/lock.ts`,
`src/components/LockScreen.tsx` (the lock screen itself, rendered by
`App.tsx` over everything until unlocked), and
`src/components/AppLockSettings.tsx` (enrollment UI).

## What the lock is and isn't

This is an access gate on the UI, not disk encryption. The mail cache is
already SQLCipher-encrypted with a key in the OS keychain regardless of the
lock; the lock stops someone with your unlocked desktop session from
casually opening your mailbox. An attacker with your OS user account can
get past it (they have your keychain); that boundary belongs to the OS,
same as for every other keychain-using app.

## Password path

- `set_app_lock_password` hashes the password with Argon2id (the `argon2`
  crate, default parameters, random salt) and stores the PHC hash string in
  the OS keychain under the reserved entry name `__app_lock_password__` --
  same sentinel-name pattern as the cache key. The password itself is never
  stored and is zeroized after hashing.
- `verify_app_lock_password` re-reads the hash and verifies. Wrong
  passwords, malformed stored hashes, and a missing entry all just fail
  verification.
- `clear_app_lock_password` deletes the keychain entry.

The hashing/verification helpers are pure functions with unit tests
(round-trip, wrong password, malformed hash, per-hash salts).

## Passkey path

Real FIDO2/CTAP2 over USB HID via the `ctap-hid-fido2` crate -- not
WebAuthn, which isn't reliably available inside the system webview. The
relying-party id is a fixed local constant (`helix.app`); nothing here
talks to a server, so it only needs to be stable between enrollment and
unlock.

- `register_app_lock_passkey(pin)`: MakeCredential against the connected
  key with a fresh random challenge, verify the attestation, and persist
  the credential id + public key (DER) in the encrypted cache's
  `app_lock_passkey` table (single row).
- `passkey_unlock(pin)`: GetAssertion with a fresh challenge against the
  stored credential id, then verify the assertion signature against the
  stored public key. Only a verified signature unlocks -- mere presence of
  a key is not enough.
- `pin` is the security key's own PIN, required only if the key has one
  set; the frontend surfaces the PIN field when the key demands it.

### The `passkey` cargo feature

The HID stack needs libudev headers to build on Linux (`libudev-dev` on
Debian/Ubuntu), so the dependency is optional:

```
cargo build --features passkey
```

Default builds compile without it; the two passkey commands still exist
but return a clear "this build has no passkey support" error, and
`get_app_lock_config` reports `passkey_available: false` so the settings
UI explains how to enable it instead of showing a dead button. The
password path works in every build. To ship passkey support by default,
add `passkey` to the `default` feature list in `src-tauri/Cargo.toml`.

## Frontend flow

On startup `App.tsx` calls `get_app_lock_config` once. If any method is
enrolled, the `LockScreen` renders instead of the mailbox (nothing behind
it is interactable) until `verify_app_lock_password` returns true or
`passkey_unlock` verifies. The lock check failing entirely (no backend,
browser dev mode) fails open -- the lock is a convenience gate, and
locking the user out of a build that can't check would be worse.
