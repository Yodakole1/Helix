# Using Helix

The full manual. Everything described here is real, working behavior in
the current build, on all three desktop platforms Helix runs on (Windows,
macOS, Linux); mobile apps (iOS/Android) are planned but not built yet.
Getting Helix onto your machine in the first place is covered in
[installation.md](installation.md).

## Adding an account

The welcome screen's "Add your first account" button -- or, once you have
one, Settings > Accounts > "Add account" -- opens the account setup page
(it opens as its own tab, so it never blocks the rest of the app):

1. Enter a display name (optional), your email address, and your password
   (an app-specific password if your provider requires one for IMAP/SMTP).
   **Gmail or Microsoft 365?** Skip the password: the "Sign in with
   Google" / "Sign in with Microsoft" buttons open your browser to sign
   in there (with your existing session and two-factor setup), and Helix
   picks up automatically when you finish. No app password, and your
   provider password never touches Helix.
2. Pick the incoming protocol: IMAP (default, recommended) or POP3.
3. With "advanced server settings" collapsed, Helix auto-detects your
   IMAP/SMTP host and port from your email address. Expand it to enter
   hosts, ports, and STARTTLS settings yourself (POP3 always needs manual
   entry -- it has no auto-discovery).
4. Press Connect. Helix verifies the login against the real server before
   saving anything; on failure nothing is stored. On success the password
   goes into your OS keychain and Helix reads the server's actual folder
   list to find your real Sent/Trash/Archive/Drafts/Spam folders --
   including providers that call them `INBOX.Sent` or `[Gmail]/Sent Mail`.
5. Helix then checks whether the same provider offers a **calendar
   (CalDAV)** and an **address book (CardDAV)** with the same credentials,
   and shows a checkmark per service. Press Continue to add whatever
   worked and open your inbox; anything that didn't work can be added
   later from Settings, and "Skip, just mail" sets up only the mailbox.

Remove or edit an account later from Settings > Accounts. Removing an
account deletes its keychain credential and its cached mail.

## The window

Helix draws its own window title bar. From left to right:

- **Tabs.** Browser-style tabs, each an independent view -- a mailbox
  (any account/folder), the calendar, or the address book. `+` opens a
  new tab; tabs shrink evenly as more open, exactly like a browser, so
  they always fit. `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle through them.
- **Drag space.** The empty middle is the window drag area; double-click
  it to maximize.
- **Search.** Searches the open account's mail: what's on screen narrows
  instantly, the server is searched live over IMAP, and the local offline
  index (every message Helix has ever cached, across folders) fills in
  matches the live window misses. The funnel button opens structured
  filters -- From, To, date ranges, unread/starred/has-attachment.
  Press `/` to focus search from anywhere.
- **Refresh.** Re-fetches the open folder and re-applies your rules.
- **Window controls.** Minimize, maximize, close.

Below that, the classic three panes: **sidebar** (accounts and folders),
**message list**, and **reader pane**, with draggable dividers. On narrow
windows the sidebar becomes an overlay and the list/reader stack into one
view with a back button.

## The sidebar

- Click an account to switch to it; click again to collapse its folder
  tree. Right-click an account to rename it or change its color -- that
  color follows the account everywhere (tabs, highlights, badges).
- Folders show live unread counts. Right-click a folder to rename, empty,
  or delete it. "+ New folder" creates a real folder on the server (Helix
  handles servers that require an `INBOX.` prefix automatically).
- The footer buttons open the **Calendar** tab, the **Address Book** tab,
  and **Settings**.

## Reading mail

- Click a message to open it. Opening marks it read on the server;
  "mark unread" is in the action row.
- **Action row**: star, archive, spam, delete, snooze, mark unread, print,
  view source, mute thread. Moves and deletes show up in the destination
  folder immediately.
- **Remote images** are blocked by default (they're how senders track
  you). Per message you can load them once, or allow a sender's domain
  permanently; the default lives in Settings > Privacy & Security.
- **Attachments** are listed with name and size -- click to download.
  Calendar invites (.ics) render as a card with Accept / Tentative /
  Decline buttons that reply to the organizer.
- **Conversation view** (Settings > General) groups a folder into
  threads: one row per conversation, expandable to its replies.
- **Snooze** hides a message until a time you pick; it comes back to the
  list when due.
- **Spam**: "Move to spam" also trains the local Bayesian filter; the
  spam folder's banner has "Not spam" which moves the message back and
  untrains it. Suspected spam is flagged in the list.
- **Read receipts**: when a sender requests one, Helix asks you -- it
  never confirms you read something on its own.

## Writing mail

Compose (the sidebar button or `C`) opens a docked window in the corner,
so you can keep reading while you write.

- **Recipients**: type an address and press Enter or comma; autocomplete
  draws from your real address book. Cc/Bcc expand from the To row.
- **From**: with more than one account, pick which one sends; an account
  with send-as aliases (Settings > Accounts) gets an address picker too.
- **Formatting**: compose is rich text by default -- bold, italic,
  underline, bulleted and numbered lists, and links (select text, press
  the link button, type the URL) all work directly. The "RT" button
  switches to plain text and back; PGP-encrypted mail always sends as
  plain text.
- **Attachments**: the paperclip stages files as chips showing name and
  size. Attaching a file with the same name again *replaces* it and marks
  the chip "v2" -- updating a document never silently duplicates it.
  Large images get a **Shrink** button that resizes and re-encodes them
  (a phone photo drops from ~8 MB to well under 1 MB) before sending.
- **Templates**: insert a saved snippet or save the current draft as one.
- **Drafts** auto-save every few seconds -- locally and to the server's
  Drafts folder, so other clients see them too. Closing compose discards
  the draft deliberately; the saved copy is removed.
- **Send later**: pick a date and time; the message waits in the outbox.
- **Undo send**: after Send, a toast gives you a few seconds to change
  your mind before the message actually leaves. When it does, your Sent
  folder updates on its own.
- **Encrypt** (PGP): requires the recipient's public key -- Helix looks
  one up automatically (WKD) and tells you per recipient whether it found
  one. S/MIME signing/encryption is under the same options once a
  certificate is imported in Settings.

## Calendar

The sidebar's Calendar button opens the calendar tab; the sidebar then
lists your connected calendars.

- Calendars come from CalDAV -- added during account setup or later via
  "Add calendar" (username + password is usually enough; Helix finds the
  server itself).
- Create events by clicking a day; edit or delete by clicking an event.
  Events support location, description, recurrence, and a reminder.
- **Reminders**: Helix checks upcoming events and fires a desktop
  notification shortly before each one starts. Configure the lead time
  (or turn reminders off) in Settings > Notifications.

## Address book

The sidebar's Address Book button opens the contacts tab. The sidebar
then lists your address books: everything, the locally collected
contacts, and each synced CardDAV book -- click one to filter.

- Contacts accumulate automatically from mail you read and send; CardDAV
  books sync on demand (Sync button) and during account setup.
- Add a contact manually, rename one (Edit), or remove one. Removing a
  locally-collected contact only forgets it locally -- it returns if you
  correspond with that address again.
- Compose autocomplete reads from this same address book.

## App lock

Settings > Privacy & Security > App lock. Both methods are optional:

- **Password**: set one and Helix shows a lock screen once per start;
  the password itself is never stored, only a hash.
- **Security key (passkey)**: enroll a FIDO2 key (YubiKey or similar);
  unlocking means plugging it in and touching it. If the key has a PIN,
  Helix asks for it. Security-key support is a compile-time option: a
  default build shows "Not available in this build" here, and the fix is
  a build with the `passkey` feature (on Linux, install `libudev-dev`
  first) -- see [the installation guide](installation.md) for the exact
  commands. The password lock works in every build.

With both set, either unlocks. With neither, Helix opens straight to
your mail. Unlocking lasts until you close the app.

## Settings

Settings stage your changes: nothing applies until you press **Save**
(applies, stays open) or **Done** (applies and closes). Closing any other
way discards the changes.

- **General**: compact list, unified inbox, conversation view, separate
  unread/read sections, signature.
- **Accounts**: connected accounts, add/edit/remove, send-as aliases.
- **Appearance**: text size (Small / Default / Large / Larger), accent
  color per account, typography. Dark is the only theme, by design.
- **Notifications**: OS permission, new-mail notifications, calendar
  reminders and their lead time.
- **Privacy & Security**: remote-image blocking, read receipts, encrypt
  by default, the app lock, PGP keys, S/MIME certificates.
- **Contacts / Calendar**: CardDAV and CalDAV sources.
- **Data & Storage**: cache size and clearing, sync depth (headers only
  vs. pre-fetching bodies for offline reading).
- **Rules**: if-this-then-that auto-sorting (conditions on From/Subject/
  To; actions: move, mark read, star). Rules run when a folder loads and
  on refresh.
- **Templates**: manage saved compose templates.
- **Shortcuts**: every shortcut, each rebindable -- click a combo and
  press the new keys.
- **About**: project info, source link, a way to support development, and
  **Check for updates** -- updates download from the official release feed
  and are cryptographically verified before installing, and Helix only
  checks when you press the button (it never phones home on its own).

## Keyboard shortcuts (defaults)

| Key | Action |
|---|---|
| `C` | Compose |
| `/` | Focus search |
| `R` / `A` / `F` | Reply / Reply all / Forward |
| `E` | Archive |
| `Backspace` | Trash |
| `S` | Star / unstar |
| `Shift+U` | Mark unread |
| `Shift+I` | Mark all read |
| `J` / `K` | Next / previous message |
| `Shift+R` | Refresh |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl/Cmd+,` | Settings |
| `Esc` | Close dialog |

All except the tab switcher are rebindable in Settings > Shortcuts, and
are inactive while typing in a text field.

## Privacy notes

- Passwords go only to your OS credential store (Secret Service on
  Linux, Keychain on macOS, Credential Manager on Windows), never into
  Helix's own storage.
- Cached mail, contacts, calendar events, and PGP/S-MIME key material
  live in a SQLCipher-encrypted database whose key is itself in the OS
  keychain.
- Helix never phones home. There is no telemetry, no crash reporting
  service, no update pings -- the only servers it talks to are yours.
- Helix will not add read receipts on outgoing mail, tracking pixels, or
  link tracking. Knowing whether your recipient opened your mail requires
  spying on them; Helix blocks that when others do it and won't do it
  for you.
