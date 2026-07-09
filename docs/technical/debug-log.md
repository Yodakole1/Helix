# Debug log and Debug mode

An in-memory, app-wide activity log for troubleshooting, surfaced in
Settings → About behind a **Debug mode** toggle.

## Backend (`src-tauri/src/debug_log.rs`)

A bounded (`MAX_ENTRIES` = 500, oldest dropped first) `VecDeque` behind a
`static Mutex`, with one write API the rest of the backend calls directly:

```rust
debug_log::record("imap", format!("login to {host}:{port} as {email} failed: {e}"));
```

Entries are `{ timestamp (RFC 3339 UTC), source, message }`. Two commands
expose it: `get_debug_log` (returns the whole buffer) and `clear_debug_log`.
In-memory only, deliberately: it never touches disk, so it can't leak into
backups or persist beyond the process, and there's nothing to rotate.

**No secrets, ever.** Messages carry hosts, ports, folder names, account
emails (already visible throughout the UI), URLs, and outcome text --
never passwords, tokens, message bodies, or subjects. `record` call sites
are responsible for upholding this; review any new one for it.

## What records where

| source | call sites |
|---|---|
| `caldav` / `carddav` | every DAV request: method, URL, HTTP status or transport error (the log's original scope) |
| `imap` | TCP/TLS connect failures, LOGIN and XOAUTH2 authentication failures |
| `pop3` | connect and login failures |
| `smtp` | every send: success (host, account) or failure with the error |
| `idle` | new-mail push events (count, folder, account) and session drops/reconnect backoff |
| `oauth` | access-token refreshes, success and failure (provider + account, never the token) |
| `account` | account add (IMAP/OAuth/POP3) and removal |
| `notify` | every desktop notification: sent (by title) or the delivery error |

Successes are logged where they're rare and meaningful (a send, a push
event, a token refresh); routine per-command successes (every IMAP connect
of the 60-second poll) are not, so the 500-entry window stays hours deep
instead of minutes.

## Frontend

`src/lib/debugLog.ts` wraps the two commands;
`src/components/DebugLogSettings.tsx` owns both pieces of UI:

- **`DebugSettings`** (exported) -- the Settings → About section: the Debug
  mode toggle (`helix:debugMode` in localStorage, instant-apply like the
  notification toggles, not staged through the settings draft) and, while
  enabled, the log viewer below it.
- **`DebugLogSettings`** (module-private) -- the viewer: Copy all / Clear /
  Refresh, selectable monospace text, loading/error states.

Debug mode is a *visibility* switch, not a collection switch -- the backend
records unconditionally (entries from before the toggle was flipped are
exactly the ones a user turns it on to see). It also reveals the **Send
test notification** button in Settings → Notifications (read from
localStorage at render time there), which is hidden in normal use; see
`notifications-and-refresh.md`.

The viewer originally lived in Settings → Data & Storage and covered only
DAV requests; it moved to About when the log went app-wide (2026-07-09).
