# Auto-updates

For an app whose pitch is security, shipping installers with no update
channel is the weakest link: a TLS or sanitizer fix that can't reach
users isn't much of a fix. Helix wires Tauri's updater plugin
(`tauri-plugin-updater`) with signed packages so Windows and macOS
installs can update in place. (Linux users on the planned apt repository
update through `apt` like everything else on their system; the updater
also handles the AppImage case.)

## How it works

- `tauri.conf.json` configures the plugin: the update **public key** and
  the endpoint `https://github.com/Yodakole1/Helix/releases/latest/download/latest.json`.
  `bundle.createUpdaterArtifacts: true` makes `tauri build` emit, next to
  each installer, a `.sig` file -- a minisign signature over the package.
- Every downloaded update is verified against the public key baked into
  the running binary before it installs. A package that isn't signed by
  the project's private key -- a compromised GitHub account, a
  man-in-the-middle, a corrupted download -- fails verification and is
  rejected. The GitHub endpoint is reached over TLS, but the signature is
  the actual trust anchor; TLS is just transport.
- Checking is **manual**: Settings > About > "Check for updates". Helix
  doesn't phone anywhere without being asked (same posture as remote
  images and read receipts), so there is no startup update ping. The
  check, download/install (with progress), and "Restart now" (via
  `tauri-plugin-process`'s relaunch) all live in
  `src/components/UpdateSettings.tsx`.
- The updater registers in `lib.rs` behind `#[cfg(desktop)]`: mobile
  builds get updates from app stores, not from this channel.

## Keys

The signing keypair was generated with `npx tauri signer generate`. The
public half is committed in `tauri.conf.json`; the private half lives
**outside the repository** at `~/.tauri/helix-updater.key` on the
maintainer's machine and must never be committed. Losing it means users
on old versions can never auto-update again (the pubkey baked into their
binaries won't match anything you can sign), so back it up like a
password. Rotating it requires shipping one release signed with the old
key that carries the new pubkey.

## Cutting a release

1. Bump `version` in `src-tauri/tauri.conf.json` (and keep
   `src-tauri/Cargo.toml` / `package.json` in step).
2. Build with the signing key in the environment:

   ```
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/helix-updater.key)" npm run tauri build
   ```

   The variable is `TAURI_SIGNING_PRIVATE_KEY` -- there is no `_PATH`
   variant in the Tauri v2 CLI (a build with only the misnamed variable
   set fails at the very end with "A public key has been found, but no
   private key", after the installers are already bundled). Add
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key was generated with
   one.

   This produces the installers plus `.sig` files under
   `src-tauri/target/release/bundle/`.
3. Create a GitHub release and upload the installers, their `.sig`
   files, and a `latest.json` manifest:

   ```json
   {
     "version": "0.2.0",
     "notes": "What changed, one paragraph.",
     "pub_date": "2026-07-05T12:00:00Z",
     "platforms": {
       "linux-x86_64": {
         "signature": "<contents of the .AppImage.sig>",
         "url": "https://github.com/Yodakole1/Helix/releases/download/v0.2.0/Helix_0.2.0_amd64.AppImage"
       },
       "windows-x86_64": {
         "signature": "<contents of the .exe.sig or .msi.sig>",
         "url": "https://github.com/Yodakole1/Helix/releases/download/v0.2.0/Helix_0.2.0_x64-setup.exe"
       },
       "darwin-x86_64": {
         "signature": "<contents of the .app.tar.gz.sig>",
         "url": "https://github.com/Yodakole1/Helix/releases/download/v0.2.0/Helix_x64.app.tar.gz"
       },
       "darwin-aarch64": {
         "signature": "<contents of the aarch64 .app.tar.gz.sig>",
         "url": "https://github.com/Yodakole1/Helix/releases/download/v0.2.0/Helix_aarch64.app.tar.gz"
       }
     }
   }
   ```

   The `releases/latest/download/latest.json` endpoint always points at
   the most recent release's copy, so old builds find new versions
   without the endpoint ever changing.

## Verification

Fully exercising an update requires two signed releases and a real
GitHub release feed, so there is no automated test. What was verified
locally: the app builds with the plugin registered and configured, the
Settings UI runs the check against the configured endpoint and surfaces
the (expected, pre-first-release) failure cleanly, and `tauri build`
emits `.sig` artifacts when the signing key is present.
