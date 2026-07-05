# Helix

Helix is a lightweight, privacy-focused desktop email client for Windows,
macOS, and Linux; mobile apps (iOS/Android) are planned. It connects
directly to your mail provider over IMAP, POP3, and SMTP -- there is no
sync service in the middle and no Helix account. Your password lives in
your operating system's own credential store, the local copy of your mail
is encrypted on disk, and every server connection is TLS (or a mandatory
STARTTLS upgrade) with no plaintext fallback.

"Lightweight" means the app itself: Helix runs in your OS's own native
webview instead of bundling an entire second copy of Chrome the way
Electron-based clients do, so the install is small and it doesn't sit
idle eating memory. See
[`docs/technical/security.md`](../technical/security.md) for the
technical detail behind the privacy and security claims.

## What works today

Helix is in early development but the client is functionally complete for
everyday mail:

- **Accounts.** IMAP or POP3 incoming, SMTP outgoing, any number of
  accounts. Server settings are auto-discovered where possible and can
  always be entered manually. Logins are verified before anything is
  saved. Special folders (Sent, Trash, Archive, Drafts, Spam) are detected
  from the server's real layout -- including hosting providers that nest
  everything under `INBOX.`.
- **Mail.** Reading (sanitized HTML with remote images blocked by
  default), sending (rich text, attachments, Cc/Bcc, send-as aliases),
  replies and forwards with proper threading headers, drafts that
  auto-save locally and to the server, undo send, scheduled send, snooze,
  server-side folder management, message search (live IMAP plus offline
  full-text search of everything cached), a unified inbox across accounts,
  and desktop notifications for new mail.
- **Organization.** Conversation (threaded) view, rules/auto-sorting,
  a local Bayesian spam filter trained by your own "spam"/"not spam"
  clicks, folder subscriptions, message templates, per-account colors and
  names, and an optional unread/read split in the message list.
- **Calendar.** CalDAV calendars (auto-discovered from your provider),
  event creation/editing, meeting invites (accept/decline from the
  message), and desktop reminders before events start.
- **Contacts.** A local address book harvested automatically from mail
  you read and send, CardDAV address book sync, and a full address-book
  tab where contacts can be added, renamed, and removed.
- **Security.** PGP (generate/import keys, encrypt/sign/decrypt/verify,
  automatic key discovery via WKD), S/MIME, an encrypted local cache, and
  an optional app lock (password and/or FIDO2 security key, asked once
  per start).
- **The shell.** Browser-style tabs (mailboxes, calendar, address book),
  a custom title bar with search and window controls, resizable panes,
  rebindable keyboard shortcuts, and adjustable text size.

## What's not there yet

- Mobile (iOS/Android) builds -- the UI is written to be portable, but
  only desktop is built today.
- OAuth2 login (Gmail/Outlook app passwords work; native OAuth doesn't) --
  Helix currently prioritizes standard IMAP/SMTP providers and custom
  domains.
- Prebuilt installers and the apt repository -- planned for the first
  public release; today Helix builds from source.
- Recipient tracking (knowing when someone opened your mail or clicked a
  link) is deliberately absent: it requires embedding trackers in your
  outgoing mail, which is exactly the behavior Helix blocks in the other
  direction. It will not be added.

## Running Helix

From the project root:

```
npm install
npm run tauri dev      # development window
npm run tauri build    # a real installer/binary
```

Linux needs a running Secret Service provider (GNOME Keyring or KWallet)
for credential storage and Tauri's build packages -- see
[`installation.md`](installation.md) for the full per-OS walkthrough
(what `tauri build` produces on each platform, installing the `.deb`,
and the optional security-key build flag).

See [`guide.md`](guide.md) for the full manual.
