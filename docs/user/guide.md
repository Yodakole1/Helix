# Using Helix

A walkthrough of what's actually usable today. See `docs/user/overview.md`
first for the real-vs-sample-data distinction this guide assumes throughout
-- in short: account setup, PGP keys, notifications, the local cache,
templates, rules, and shortcuts are real; the inbox you read and write mail
in is still a sample-data preview.

## Connecting an account

The welcome screen's "Add account" button, or Settings > Accounts' "+ Add
account" button, both open the same connect-an-account dialog:

1. Enter a display name (optional), your email address, and your password
   (an app-specific password, if your provider requires one for IMAP/SMTP
   access).
2. Leave "advanced server settings" collapsed and Helix will try to
   auto-detect your IMAP/SMTP host and port from your email address. If
   that fails, or you need a non-default setup, expand it and enter the
   IMAP host/port and SMTP host/port (and whether SMTP uses STARTTLS)
   yourself.
3. Press Connect. Helix verifies the login against your real IMAP server
   before saving anything -- if it fails, nothing is stored. If it
   succeeds, the password goes straight into your OS's keychain (never into
   app storage), and the account's connection details are saved.

The account now shows up in Settings > Accounts' "Connected accounts" list,
with a Remove button. It does **not** yet show up in the sidebar or change
what mail you see -- the sidebar's account list is still the sample-data
one described in the overview. Connecting an account today is for setting
up and testing the real onboarding/PGP/notification features below, not yet
for reading your real mail in the main window.

## The three-pane layout

- **Sidebar** (left): your accounts, each with its own folder tree and
  accent color. Click an account to switch to it; click a folder to open
  it. Right-click an account to rename it or pick a different color.
- **Message list** (middle): the open folder's messages. Search reaches
  every folder in the account at once; the filter panel (funnel icon) and
  sort menu stay scoped to the open folder. The refresh icon re-applies
  your rules (see below) -- it doesn't fetch new mail yet.
- **Reader pane** (right): the selected message. On narrower windows the
  sidebar becomes a dismissable overlay (corner menu button), and below
  that, the list and reader pane share one view with a back button.

## Reading and organizing mail

- **Reply / Reply All / Forward**: buttons in the reader pane's header.
  Reply-All includes any Cc participants on the original message; Forward
  starts with an empty "To" and a labeled block of the original message
  instead of quoting it.
- **Star, archive, mark as spam, delete, mark unread**: the icon row next
  to Reply. All of these persist for your session.
- **Remote images**: blocked by default in HTML messages, with a "Show
  images" link per message if you want to load them anyway (Settings >
  Privacy & Security controls the default).
- **Attachments**: shown per message with name and size. Downloading isn't
  available yet -- see the overview for why.
- **Light/dark content toggle**: per-message, for mail that's unreadable in
  Helix's dark theme.
- **Unified inbox**: Settings > General > "Unified inbox" merges every
  account's Inbox into one list, tagging each row with its account.

### Rules & auto-sorting

Settings > Rules:

1. Press "+ New rule."
2. Give it a name.
3. Add one or more conditions: a field (From, Subject, or To) contains some
   text. All conditions on a rule must match.
4. Add one or more actions: move to a folder, mark as read, or star.
5. Save. Toggle a rule off without deleting it via the switch next to its
   name.

Rules run when you open a folder or switch accounts, and when you press the
message list's refresh button -- see "How rules run" in the overview for
why there's no fully automatic background version yet.

### Templates / Quick Parts

In Compose, the Templates button (next to Attach) opens a list of your
saved templates -- click one to insert it. If your draft already has text,
the template is appended rather than replacing it. To save a new one, type
your draft, open the Templates list, and use "Save current draft as
template." Manage (and delete) saved templates from Settings > Templates.

## Composing

- **To/Cc/Bcc**: type an address and press comma or Enter to commit it as a
  chip; Backspace on an empty field removes the last chip. Suggestions
  appear as you type (drawn from sample senders today, not a real address
  book yet).
- **Attach**: picks real files from your filesystem and shows them as
  chips -- they aren't sent anywhere yet, since Send itself isn't wired up.
- **Formatting toolbar**: visual only for now: it doesn't yet format the
  message body.
- **Encrypt toggle**: flips local state only -- see the overview for why
  this isn't real encryption yet, even though the key management behind it
  is.
- **Signature**: set one in Settings > General; it pre-fills a blank new
  draft (never overwrites one already in progress).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `C` | Compose a new message |
| `/` | Focus the search box |
| `R` | Reply to the open message |
| `A` | Reply all |
| `F` | Forward |
| `E` | Archive the open message |
| `Backspace` / `Delete` | Trash the open message |
| `Cmd/Ctrl + ,` | Open Settings |
| `Esc` | Close the open dialog |

These are inactive while you're typing in a text field, or while a dialog
is open, so they won't fire by accident. Fixed for now -- not yet
rebindable. The same list is always available in Settings > Shortcuts.

## Settings tour

- **Accounts**: the sample account list the rest of the app reads from,
  plus the real "Connected accounts" list described above.
- **Notifications**: request OS notification permission and send a test
  notification. "Notify on new mail" is saved but won't fire yet -- there's
  no new-mail detection in Helix yet for it to react to.
- **Data & Storage**: real local cache size/message count, and a real
  "Clear cache" (this only clears cached mail, never your accounts,
  contacts, or PGP keys).
- **Shortcuts**: reference list, see above.
- **Templates**: manage saved Compose templates.
- **Rules**: manage auto-sorting rules.
- **Appearance**: pick the active account's accent color (click a swatch);
  typography preview. Dark mode is the only mode -- Helix is OLED-first by
  design.
- **Privacy & Security**: block remote images, read receipts (off, and
  not implemented either way), default Encrypt state for new drafts, and
  PGP key management (generate/import a keypair for the active account,
  export your public key, import a contact's public key).
- **General**: compact message list density, unified inbox, signature.
- **About**: project info and links.

## Privacy and security notes

- Account passwords go straight to your OS's credential store (Secret
  Service on Linux, Keychain on macOS, Credential Manager on Windows) --
  never into Helix's own storage, and never read back into the app except
  at the moment you connect an account.
- The local cache (used for stats/clearing today, and for future offline
  reading) is SQLCipher-encrypted at rest, with its own key in your OS
  keychain.
- PGP keys you generate or import are stored in that same encrypted cache.
  There's no separate passphrase on the secret key beyond that -- it relies
  on your OS account's own security, the same as every other app that uses
  your keychain.
