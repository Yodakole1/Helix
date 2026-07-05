# Installing Helix

Helix runs on Windows, macOS, and Linux from one codebase (mobile apps
for iOS and Android are planned but not built yet). This guide covers
getting it onto each of those, and what the app needs from the system
once it's there.

## Prebuilt packages

Helix is in early development and does not publish prebuilt packages
yet. For the first public release the plan is:

- **Debian/Ubuntu**: an apt repository, so installing is
  `sudo apt install helix-mail` and updates arrive with your normal
  system updates. Until that repository exists, building from source
  produces a proper `.deb` you can install the same way (below).
- **Other Linux**: the same build also produces an `.rpm` and a
  self-contained `.AppImage`.
- **Windows**: an `.msi` installer.
- **macOS**: a `.dmg`.

Everything below works today.

## Building from source

The build needs Node.js v22+ and the Rust toolchain via
[rustup](https://rustup.rs) on every platform, plus the per-OS native
dependencies listed in the next section.

```
git clone https://github.com/Yodakole1/Helix.git
cd Helix
npm install
npm run tauri build
```

`npm run tauri build` compiles the frontend and the Rust shell in release
mode and then packages every installer format the current OS can produce,
under `src-tauri/target/release/bundle/`:

| OS | What you get | Where |
| --- | --- | --- |
| Linux | `.deb`, `.rpm`, `.AppImage` | `bundle/deb/`, `bundle/rpm/`, `bundle/appimage/` |
| Windows | `.msi` (WiX) and setup `.exe` (NSIS) | `bundle/msi/`, `bundle/nsis/` |
| macOS | `.dmg` and the raw `Helix.app` | `bundle/dmg/`, `bundle/macos/` |

Installers are always built for the OS you run the build on -- there is
no cross-compiling a Windows installer from Linux.

### Installing the Linux .deb

```
sudo apt install ./src-tauri/target/release/bundle/deb/Helix_0.1.0_amd64.deb
```

`apt` resolves the runtime dependencies (WebKitGTK and friends) declared
in the package. Removing it later is `sudo apt remove helix`.

The `.AppImage` needs no installation at all: mark it executable and run
it. It still needs a Secret Service provider on the host system (see
below).

## Per-OS native build dependencies

### Linux (Debian/Ubuntu)

```
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Other distributions need their equivalents -- see Tauri's Linux
prerequisites documentation for exact package names.

### macOS

Xcode Command Line Tools (`xcode-select --install`). Nothing else beyond
Node and rustup.

### Windows

The MSVC build tools ("Desktop development with C++" workload in the
Visual Studio installer) and the WebView2 Runtime, which Windows 11 and
up-to-date Windows 10 systems already have.

## What Helix needs at runtime

- **Linux: a Secret Service provider.** Helix stores your mail passwords
  in the OS keychain, never in its own files, so it needs GNOME Keyring
  or KWallet running and unlocked. Standard GNOME and KDE desktops have
  this out of the box; minimal window-manager setups may need to install
  and autostart one. Without it, adding an account fails with a keychain
  error rather than falling back to anything less safe.
- **Windows/macOS**: Windows Credential Manager and macOS Keychain are
  part of the OS; nothing to install.

## Optional: security-key (passkey) unlock

Helix's app lock supports FIDO2 security keys (YubiKey and similar), but
that support is a compile-time option. A default build shows

> **Security key (passkey)** -- Not available in this build

in Settings > Privacy & Security > App lock, and the password lock works
in every build. To get the security-key path, rebuild with the `passkey`
feature -- on Linux, its USB stack additionally needs the libudev
headers:

```
sudo apt install libudev-dev        # Linux only
cd src-tauri
cargo build --features passkey      # or: npm run tauri build -- --features passkey
```

Planned prebuilt Linux packages will ship with this enabled, since the
apt dependency chain can pull in libudev automatically.

## First run

Start Helix and follow the welcome screen -- the whole flow is described
in [the user guide](guide.md#adding-an-account). For development (hot
reload, no packaging), `npm run tauri dev`; developer-oriented setup
details live in [`docs/technical/setup.md`](../technical/setup.md).
