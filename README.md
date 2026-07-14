# Helix

Your email lives on your server. Helix is the client that finally treats it
that way.

Helix is a fast, privacy-focused desktop email client for Windows, macOS,
and Linux (with mobile apps for iOS and Android planned) that connects
straight to your mail provider over IMAP, POP3, and SMTP. No sync service
in the middle, no company reading your mail to "improve your experience",
no account with us at all. Your password goes into your operating system's
keychain, your cached mail sits in an encrypted database on your own disk,
and every connection is TLS with no plaintext fallback anywhere in the
codebase. That's the whole business model: there isn't one.

It's also built for the mail most clients forgot. If your address is
`you@yourdomain.com` on some hosting provider's server rather than Gmail,
Helix is aimed at you -- it detects the odd folder layouts those servers
use (`INBOX.Sent` and friends), speaks CalDAV and CardDAV to the same host
with the same credentials, and doesn't assume the world ends at OAuth.

## What you get

- **A real mail client.** Multiple accounts, unified inbox, browser-style
  tabs, threaded conversations, full-text search that works offline,
  server-side folders, drafts that sync, scheduled send, undo send, and
  snooze.
- **Privacy by default.** Remote images blocked until you allow them, read
  receipts never sent without asking, a local Bayesian spam filter that
  learns from you instead of reporting to a server, and optional PGP and
  S/MIME end-to-end encryption.
- **Calendar and contacts included.** CalDAV calendars with desktop
  reminders, CardDAV address books, and meeting-invite handling (accept or
  decline from inside the message).
- **An app lock, if you want one.** Lock Helix behind a password, a FIDO2
  security key, or both -- asked once per start, then out of your way.
- **Dark, glassy, and fast.** A dark-first interface (with an optional muted light theme) on a Tauri shell that
  uses your OS webview instead of shipping a whole browser, so the
  installed app and its idle footprint stay small.

## Install

Helix runs on Windows, macOS, and Linux, and is built from one codebase
for all three. It's early -- this is the `0.1.0` release, and only a
Debian/Ubuntu `.deb` is published on the
[Releases page](https://github.com/Yodakole1/Helix/releases) so far:

```
sudo apt install ./Helix_0.1.0_amd64.deb
```

`.rpm`/`.AppImage` for other Linux distros, a Windows `.msi`, and a macOS
build are planned for upcoming releases (an apt repository, so installing
becomes a single `apt install` with no manual download, is planned further
out). Until each of those is published, building from source works on any
of the three:

```
git clone https://github.com/Yodakole1/Helix.git
cd Helix
npm install
npm run tauri build
```

That produces a real installer for whatever OS you build on -- a `.deb`,
`.rpm`, and `.AppImage` on Linux, an `.msi` on Windows, a `.dmg` on macOS
-- under `src-tauri/target/release/bundle/`. The full walkthrough,
including per-OS prerequisites and what the app needs at runtime, is in
[`docs/user/installation.md`](docs/user/installation.md).

**A note on testing:** development happens on Linux, and that's the only
platform this has actually been run and used on so far. Windows and macOS
builds compile (Tauri targets all three from the same codebase), but
nobody has installed or exercised either one yet -- if you try Helix on
Windows or macOS, bug reports are especially welcome.

For day-to-day development:

```
npm run tauri dev       # full app with hot reload
```

Prerequisites: Node.js v22+, the Rust toolchain via
[rustup](https://rustup.rs), and Tauri's native build packages. Linux also
needs a running Secret Service provider (GNOME Keyring or KWallet) for
credential storage -- exact package names are in
[`docs/technical/setup.md`](docs/technical/setup.md).

One feature is a compile-time option: unlocking the app lock with a FIDO2
security key. A default build shows "Security key (passkey) -- Not
available in this build" in Settings > Privacy & Security; the password
lock works in every build. To enable the security-key path, build with
`--features passkey` (on Linux, install `libudev-dev` first) -- see the
[installation guide](docs/user/installation.md) for details. Planned
prebuilt packages will ship with it enabled.

## First run

Open Helix, click "Add your first account", and type your email address
and password. Helix discovers the server settings where it can and lets
you type them where it can't, verifies the login before saving anything,
then checks whether your provider also offers a calendar and an address
book with the same credentials -- one checkmark per service, one Continue
button, and you're in your inbox.

Bringing many mailboxes at once? Fill in
[`accounts-import.example.txt`](accounts-import.example.txt) (one
`key: value` block per account) and use "Import accounts from a file..."
on the same page -- every account is verified before it's saved, and the
file is deleted afterwards because it contains your passwords.

The user manual lives in [`docs/user/`](docs/user) -- what every screen,
setting, and shortcut does.

## How it's put together

The interface is React Native Web inside a Tauri 2 shell; everything that
touches the network or a secret is Rust. Each backend concern (IMAP, SMTP,
POP3, caching, PGP, S/MIME, CalDAV, CardDAV, spam filtering, the app lock)
is its own module with its own documentation and tests under
[`docs/technical/`](docs/technical). If you're the kind of person who
wants to know exactly what a mail client does with your password before
you give it one, that folder is for you: start with
[`security.md`](docs/technical/security.md) and
[`credential-storage.md`](docs/technical/credential-storage.md).

## Contributing

Issues and pull requests are welcome. The technical docs describe the
architecture and the reasoning behind the stack choices; `CLAUDE.md` in
the repo root is the working map of the codebase. Run `cargo test` in
`src-tauri/` for the backend suite and `npx tsc --noEmit` for the frontend
typecheck before sending a PR.

## License

Helix is free software, licensed under the [GNU General Public License,
version 3](LICENSE) (GPL-3.0-only). You can use it, study it, modify it,
and redistribute it -- including forks -- without asking anyone. What the
license guarantees in return is that every fork and derivative stays free
software under these same terms, with source code available: nobody can
take Helix closed-source. The name "Helix" and its logo are not covered
by the code license.

## Support Helix

Helix is free, open source, and built in spare time. If it saves you from
a subscription or an ad-funded inbox, you can buy the developer a coffee:

**[buymeacoffee.com/yodakole1](https://buymeacoffee.com/yodakole1)**

![Buy me a coffee QR code](docs/for-readme/bmc_qr.png)
