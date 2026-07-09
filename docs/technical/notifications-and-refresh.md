# Notifications and auto-refresh

How new mail reaches the UI without a manual refresh, and how desktop
notifications hang off that path.

## IMAP IDLE push (`src-tauri/src/idle.rs`)

The one long-lived connection in the app. `start_idle(account, host, port,
folder)` spawns a background task per account that logs in, SELECTs the
folder (INBOX -- App.tsx starts one watcher per IMAP account when accounts
load), and runs RFC 2177 IDLE, renewing every 29 minutes. Servers without
the IDLE capability fall back to a 60-second EXAMINE poll on the same
connection. Sessions that drop reconnect with exponential backoff (1 s
doubling to a 5-minute cap). POP3 accounts are skipped -- the protocol has
no push.

When the folder's EXISTS count rises, the task emits a **`new-mail`**
event (`{ account_id, folder, exists, new_count }`) to the webview.

> History: until 2026-07-06 the backend emitted this event as
> `helix://imap-new-mail` while `App.tsx` listened for `new-mail`, so IDLE
> push never actually reached the frontend -- new mail only appeared on a
> manual refresh, and new-mail notifications never fired at all. The event
> name is the contract between `idle.rs` and `App.tsx`; if it ever changes,
> change it in both places in the same commit.

`App.tsx` handles `new-mail` by merging the affected account+folder's new
messages into the message store (the active view gets the new rows appended
in place -- no full-list replace, no flash/scroll-reset; a background
folder just has fresh rows waiting) via `loadFolder(..., merge=true)`. The
event itself only carries `new_count` (no sender/subject), so the
notification is *not* built from it directly -- `loadFolder` takes an
`onMerged` callback that receives the actual newly-merged `SampleMessage[]`
once the live fetch resolves, and that's what gets formatted into the
notification (see below).

`loadFolder`/`loadFlatFolder`/`loadPop3Folder` take a `merge` flag: an
initial folder visit (or the cache-first preview) still does a full
`store.loadMessages` replace, but `merge=true` (the poll and IDLE push,
below) always goes through `store.mergeMessages` instead, which only
appends messages whose id isn't already in the list, and calls `onMerged`
with just those.

## Desktop notifications

All real OS notifications, no stubs. Delivery is our own
`send_desktop_notification` command (`src-tauri/src/notifications.rs`),
**not** tauri-plugin-notification's JS API -- see "Why not the plugin's
delivery" below; the plugin stays registered (and `notification:default`
granted in `capabilities/default.json`) only for the permission
check/request UI in Settings. The frontend wrapper and icon-resolution
logic live in `src/lib/notifications.ts`, shared by every call site below:

- **New mail** -- `notifyNewMail(messages)` in `notifications.ts`, called
  from both the `new-mail` event's `onMerged` callback *and* the 60s poll
  below (each diffs the freshly-fetched messages against what's already in
  the store before merging, and passes just the new ones -- a poll tick
  doesn't come with a server-reported count the way IDLE's event does).
  Gated on the `helix:notifyNewMail` localStorage flag, read at call time so
  the Settings toggle applies without a restart. Covering the poll too (not
  just IDLE) matters because IDLE sessions do drop and reconnect with
  backoff -- mail arriving during that gap now still notifies once the poll
  picks it up, instead of surfacing silently. The notification's title is
  the sender's address and its body the subject (falling back to a "N new
  messages" summary listing each sender/subject when more than one message
  arrived at once) -- not a bare count, since the whole point is knowing
  who mailed you without switching to the app.
- **Calendar reminders** -- a per-minute check in `App.tsx` over the cached
  CalDAV events, notifying when an event's start enters the configured
  lead window (`helix:reminderLeadMinutes`). Times render 24-hour.
- **Test notification** -- the button in Settings → Notifications, visible
  once the OS permission is granted *and* Debug mode (Settings → About) is
  on -- it's a troubleshooting tool, not an everyday control. Its
  body includes the current time so identical clicks in quick succession
  still produce a visibly distinct notification -- some notification
  daemons (GNOME Shell among them) update an existing banner in place
  rather than popping a new one for an exact repeat of the same
  summary+body, which otherwise reads as "it only works once". Failures
  reject with the backend's real error and render under the button.

### Why not the plugin's delivery (the GNOME disappearing-notification bug)

tauri-plugin-notification's Linux path (notify-rust) opens a **fresh DBus
connection per notification and drops it as soon as `Notify` returns** (the
plugin discards the `NotificationHandle`). GNOME Shell's notification
daemon watches each sender's bus name and, when the name vanishes, destroys
every notification source it can attribute to a running application
(`FdoNotificationDaemonSource._onNameVanished`; it spares only senders
whose pid maps to no window, which is why one-shot `notify-send` works).
Net effect, diagnosed here by monitoring the session bus on GNOME Shell 46:
`Notify` was answered with an id, and ~20 ms later GNOME emitted
`NotificationClosed` reason 2 ("dismissed") -- the banner was destroyed
before it was ever drawn. Notifications from Helix simply never appeared,
in dev and packaged builds alike, while the JS side reported success on
every layer (the plugin command is fire-and-forget in both directions).

The fix, in `notifications.rs`: keep **one session-bus connection alive for
the process lifetime** (a `OnceLock`'d `zbus::blocking::Connection` -- zbus
was already in the tree via notify-rust) and send every
`org.freedesktop.Notifications.Notify` over it, with `app_name` "Helix" and
a `desktop-entry` hint so GNOME attributes it to the installed
`Helix.desktop`. That's what libnotify-based apps get implicitly, and it
also keeps the notification in GNOME's notification list instead of it
being reaped with the connection. The DBus round trip runs through
`run_blocking` like every other blocking command. On macOS/Windows the
plugin's delivery has no such failure mode, so the same command just
forwards to the plugin's Rust builder there (`#[cfg]` split).

### Icon

`sendNotification`'s `icon` option needs a real filesystem path, which
`notify-rust`'s own `auto_icon()` (the plugin's fallback when no icon is
given) can only resolve from an *installed* `.desktop` entry's `Icon=` key
-- meaning it finds nothing in a dev build, and depends on packaging being
correct even in production. `getNotificationIconPath()` in
`notifications.ts` instead resolves `icons/128x128.png` via
`@tauri-apps/api/path`'s `resolveResource` (backed by `core:path:default`,
already covered by the `core:default` permission) and caches the result for
the session. `resolveResource` reads from `resource_dir()`, which on
desktop resolves to the compiled binary's own directory
(`target/debug`/`target/release`) when running from a Cargo output
directory, or the installed bundle's resource directory otherwise --
either way it's `tauri-build`'s `build.rs` step that actually puts
`icons/128x128.png` there, by copying every path listed under
`bundle.resources` in `tauri.conf.json` (not `bundle.icon`, which only
feeds the installer/OS icon set) into that directory on *every* build,
`cargo build`/`tauri dev` included, not just `tauri build`. So the icon
resource has to be declared there for `resolveResource` to find it in
either dev or prod, and a build that predates that config change won't have
it in its `target/` output until rebuilt.

## Auto-refresh (Thunderbird-style)

Push covers each account's INBOX; everything else refreshes on a timer,
all in `App.tsx`:

- **Active folder poll**: whatever folder is being looked at reloads every
  60 seconds (`loadFolder(..., merge=true)`, so an unchanged folder repaints
  identically and the poll is invisible -- new messages append rather than
  replacing the list). In the unified inbox the poll re-runs
  `fetch_unified_inbox` and merges the same way, per account.
- **Sent folder after send**: when the undo-send toast expires and the
  outbox flushes, `refreshSentFolder` re-reads the account record (the
  append may have just healed a wrong sent-folder name) and reloads the
  Sent folder, so the just-sent message shows up immediately.
- **CalDAV**: every source re-syncs on a 15-minute timer (and manually via
  the calendar's Sync button); reminders read the freshly-synced cache.

There is deliberately no full-mailbox background sync loop -- folders load
cache-first when opened, and the poll only covers what's on screen.
