# Development setup

This doc covers day-to-day local development, which happens on Linux.
(Installing Helix as an end user -- release builds, the installer
formats each OS produces, and the planned apt repository -- is
`docs/user/installation.md`, not this doc.)
That doesn't mean Windows/macOS are unverified, though: `.github/workflows/ci.yml`
runs `cargo test` on all three OSes (`ubuntu-latest`, `macos-latest`,
`windows-latest`) on every push/PR — see `credential-storage.md`'s
Verification section for why that matters specifically for credential
storage, which is the one thing that's genuinely platform-specific code
(a different `keyring` backend per OS, selected in `Cargo.toml`).

## Linux

### Prerequisites

- Node.js (v22+) and npm
- Rust toolchain, installed via rustup:
  ```
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- Tauri's native build dependencies (Ubuntu/Debian):
  ```
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  Other distros need different package names — check Tauri's official
  Linux prerequisites documentation for the equivalents.
- A running Secret Service provider (gnome-keyring or KWallet) — see
  `credential-storage.md` for why credential storage needs this on Linux
  specifically.

### Install and run

```
npm install
npm run tauri dev
```

This compiles the Rust shell and opens a desktop window with hot reload
from the Vite dev server.

## Windows / macOS

No local-dev walkthrough is written yet, and nobody on this project
actively develops on either — but that's a documentation gap, not an
unverified-platform gap. CI (`.github/workflows/ci.yml`) builds the Rust
backend and runs its full non-network test suite, including the
real-keychain credential round-trip test, on both `macos-latest` and
`windows-latest` on every push. Tauri's own prerequisites for those OSes
(Xcode Command Line Tools on macOS; the MSVC toolchain + WebView2 Runtime
on Windows, both preinstalled on GitHub's hosted runners) are what a
first-time local setup would need — see Tauri's official prerequisites
docs for the exact install steps until this doc gets a real walkthrough
for both.

## Optional: passkey (FIDO2 security key) app-lock support

The app lock's security-key path (`docs/technical/app-lock.md`) is behind
the `passkey` cargo feature because its USB HID stack needs libudev
headers on Linux:

```
sudo apt install libudev-dev            # Debian/Ubuntu
cd src-tauri && cargo build --features passkey
```

Default builds work without it -- the password lock is always available,
and the passkey commands return a clear "not built with passkey support"
error that the settings UI relays. To ship passkey support by default,
add `passkey` to `[features] default` in `src-tauri/Cargo.toml`.
