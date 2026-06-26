# Helix

Helix is a privacy-focused, cross-platform email client. It targets desktop
(Windows, macOS, Linux) and mobile (iOS, Android) from a single codebase,
built around local encryption, direct connections to mail providers (no
middleman servers), and a customizable, dark-mode-first interface.

## Current status

Helix is in early development. A growing set of real, working features now
sits inside what's otherwise still a sample-data preview of the inbox
itself:

**Real and working today:**

- **Account onboarding.** Settings > Accounts has a "+ Add account" button
  that opens the connect-an-account wizard. It auto-detects your provider's
  IMAP/SMTP server settings from your email address where possible (advanced
  settings are still there if you need to enter them manually), then
  genuinely connects, verifies the login over IMAP, and stores the password
  in your OS keychain (Secret Service / Keychain / Credential Manager) --
  never in app storage. The connected account shows up in Settings'
  "Connected accounts" list, with a real Remove. See the note below on what
  this is and isn't connected to yet.
- **PGP key management.** Settings > Privacy & Security can generate a new
  PGP keypair, import an existing one, export your public key, and import a
  contact's public key. This is real cryptography (Ed25519 + Curve25519),
  not a placeholder -- see the caveat below on what it isn't wired to yet.
- **Notifications.** Settings > Notifications can request real OS
  notification permission and send a real test notification.
- **Local cache stats and clearing.** Settings > Data & Storage shows the
  real size and message count of the local encrypted cache, with a real
  (confirm-before-destructive) "Clear cache" button.
- **Templates / Quick Parts.** In Compose, save your current draft as a
  reusable template, or insert a saved one. Managed from Settings >
  Templates.
- **Rules & auto-sorting.** Settings > Rules lets you build "if this, then
  that" rules (e.g. move messages from a sender into a folder, mark as read,
  star) and applies them for real against your mail. See "How rules run"
  below for exactly when.
- **Keyboard shortcuts.** A small fixed set (compose, reply, reply-all,
  forward, archive, trash, focus search, open Settings) -- see Settings >
  Shortcuts for the full list.
- **The reading experience.** The three-pane layout, search/filters, the
  account/folder sidebar, HTML message rendering (sanitized, with remote
  images blocked by default), reply/reply-all/forward composing, and
  multi-attachment display are all real UI behavior -- just running against
  sample messages rather than your real mail (see below).

**Still sample data / not wired up yet:**

- **The inbox itself.** Every message you see in the message list and
  reader pane is illustrative sample content, not your real mail. Reading,
  starring, archiving, and moving messages all work and persist for your
  session, but only against that sample data -- nothing is fetched from or
  sent to a real mail server yet from the main app window.
- **Sending.** Compose's Send button doesn't send anything yet.
- **Encryption in Compose.** The "Encrypt" toggle in Compose, and Settings'
  "encrypt new messages by default," don't yet trigger real encryption --
  the key management behind them (above) is real, but it isn't connected to
  sending or reading mail yet.
- **POP3.** Supported by the backend, not selectable anywhere in the UI yet.

This gap will keep closing. Check `docs/technical/frontend-roadmap.md` (in
the source repository) for the detailed, up-to-date list if you want to know
exactly what's real as of a given day.

### How rules run

Rules aren't a background process -- there's no "checking for new mail"
loop in Helix yet for them to hook into. They run:

- Automatically when you open a folder or switch accounts.
- When you press the refresh button in the message list (which also
  doesn't fetch anything yet, but does re-apply your rules).

A rule that's already moved a message into a folder won't re-match itself
into a loop -- moving a message into the folder it's already in is a no-op.

## Running the current dev build

From the project root:

```
npm install
npm run tauri dev
```

This opens a desktop window with the current interface. The sample inbox,
Settings, Compose, and everything described above as "real and working" are
all usable. Closing the window stops the app; Ctrl+C in the terminal also
stops the dev server.

See `docs/user/guide.md` for a walkthrough of what to actually do once it's
open.

## Planned features

- Real account sync: the account-onboarding/PGP/notifications/cache work
  above is real, but the sidebar/message list/reader pane don't read from
  it yet -- that's the next big piece.
- Real sending, and connecting Compose's Encrypt toggle to the real PGP
  encryption that already exists.
- Rich-text formatting in Compose actually applied to the message body.
- POP3 in the account-setup UI as a protocol choice.
- Email snoozing, scheduled (send-later) sending, and offline mode are on
  the list, not started yet.
