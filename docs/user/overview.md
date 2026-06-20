# Helix

Helix is a privacy-focused, cross-platform email client. It targets desktop
(Windows, macOS, Linux) and mobile (iOS, Android) from a single codebase,
built around local encryption, direct connections to mail providers (no
middleman servers), and a customizable, dark-mode-first interface.

## Current status

Helix is in early development. The desktop shell now has a fully designed
interface, but no real email functionality behind it yet:

- A three-pane layout (account/folder sidebar, message list, reader pane)
  in the dark, neon-accented "Cyber-Minimalism" style, with glass panels
  and ambient colored glow
- The sidebar lists every connected account separately, Thunderbird-style,
  each with its own folder tree (Inbox, Drafts, Sent, Spam, Archive,
  Trash) and its own accent color
- A "Compose" screen with a To/Cc/Bcc/Subject form and a formatting
  toolbar (bold, italic, underline, lists, link, attachment) -- the
  toolbar is visual only for now; it doesn't yet format text
- An "Add account" screen that takes a name, email, and password, with
  advanced IMAP/SMTP server fields tucked behind a disclosure. The
  password is genuinely stored in your OS keychain (Secret Service /
  Keychain / Credential Manager) via a Rust-side command -- but there's no
  account list, IMAP connection, or sync behind it yet
- A Settings screen (Accounts, Appearance, Privacy & Security, General)
  with a few real toggles, including one that actually changes the
  message list's density

All of the message content visible in the inbox and reader pane right now
is sample data for the design preview, not synced mail. There's still no
account persistence, no IMAP/POP3/SMTP, and no encryption.

This document will grow into real usage instructions as features land.

## Running the current dev build

From the project root:

```
npm install
npm run tauri dev
```

This opens a desktop window showing the current designed-but-not-yet-
functional interface. Closing the window stops the app; Ctrl+C in the
terminal also stops the dev server.

## Planned features

- Resizable, draggable panels (today's panel widths are fixed)
- Rich-text formatting in Compose actually applied to the message body
- PGP and end-to-end encryption, with local data encrypted at rest
- No tracking pixels and no read receipts sent without permission
- Direct IMAP, POP3, and SMTP support with provider auto-discovery during
  account setup
- Real account persistence and a working "Add account" flow beyond
  credential storage
- Unified inbox across multiple accounts, or strictly siloed per-account
  views, depending on preference
