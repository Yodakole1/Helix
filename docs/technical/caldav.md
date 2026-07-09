# CalDAV — Implementation Notes

CalDAV (RFC 4791) is a WebDAV extension for calendar data. Helix implements
it as a local-cache-backed sync system: events are fetched from the remote
server on demand, stored in SQLCipher, and served to the frontend from there.
No persistent CalDAV connection is kept open between syncs.

## Module: `src-tauri/src/caldav.rs`

Parallel to `carddav.rs` in structure. Uses `reqwest::blocking` (sync HTTP)
so all Tauri commands are plain `pub fn` rather than `pub async fn`, which
means they run on Tauri's command thread pool and don't hold the async runtime.

### HTTP operations

- `propfind(client, url, user, pass, body, depth)` — WebDAV PROPFIND
- `get_ics(client, url, user, pass)` → `(body, Option<etag>)`  
- `put_ics(client, url, user, pass, body, etag_if_match)` — PUT with
  `If-None-Match: *` for creates (prevents clobbering), `If-Match: "<etag>"`
  for updates (optimistic concurrency)
- `http_delete(client, url, user, pass)` — 404 treated as success

All use HTTP Basic Auth. TLS validation is handled by reqwest's default
native-TLS backend; no insecure connections are permitted.

### ICS parsing

`parse_vevents(ics: &str)` does line-by-line RFC 5545 parsing. Line folding
(CRLF + whitespace continuation) is stripped via `unfold_ics` before parsing.

Properties extracted per VEVENT:
`UID`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND`, `RRULE`,
`STATUS`, `SEQUENCE`, `ORGANIZER` (stripped of `mailto:` prefix).

Parameters on property names (e.g. `DTSTART;TZID=America/New_York:...`) are
stripped by splitting on `;` and taking the first part before matching.

VEVENTs without a UID are silently skipped — no stable cross-session key.

### ICS generation

`build_vcalendar(ev, sequence)` produces a VCALENDAR wrapping one VEVENT,
CRLF-terminated as required by RFC 5545. DTSTAMP is set to the current UTC
instant. `iso_to_ical(dt)` converts ISO 8601 inputs to iCal compact format
(`20260701T100000Z` / `20260701`) — ICS strings already in that format are
passed through unchanged.

### Sync logic

`do_sync(client, url, user, pass, source_id, conn)`:

1. PROPFIND Depth:1 on the collection URL → list of `(href, etag)` pairs
2. Filter to `.ics` hrefs only
3. GET each `.ics` → parse all VEVENTs → `cache::upsert_calendar_event`
4. After the loop, `cache::purge_stale_calendar_events` removes events whose
   UIDs were not seen in this sync (server-deleted events)
5. Returns `CalDavSyncResult { events_added, events_updated, events_deleted }`

Failures on individual GETs are logged and skipped, not aborted.

### RFC 6764 discovery

`discover_caldav(host, user, pass)`:

1. GET `https://{host}/.well-known/caldav` following redirects → principal URL
2. PROPFIND Depth:0 on principal for `C:calendar-home-set`
3. PROPFIND Depth:1 on each home URL for `D:resourcetype` + `D:displayname`
4. Return URLs that aren't the home itself

Partial discovery returns whatever is found, not an error — same behavior as
`carddav::discover_carddav`.

### Credential storage

Password stored in the OS keychain under `caldav__{id}` (same convention as
`carddav__{id}`). Only the ID (not the account_id or URL) is in the key name,
so the key is stable across source updates.

`add_caldav_source` follows the store-verify-persist-or-rollback pattern from
`account::add_account`: PROPFIND first (validation), then DB insert, then
keychain store, then initial sync — rolling back credentials and DB row if
either the store or the sync fails.

Every command that authenticates against a stored source (`sync_caldav`,
`create_event`, `update_event`, `delete_event`) resolves the password via
`resolve_source_password` rather than a raw keychain read. If the
`caldav__{id}` entry is genuinely missing (keychain got cleaned out, entry
never landed), it falls back to the owning account's mail credential — a
source connected during account onboarding authenticates with exactly that
password — and re-stores it under the source's own key, so the heal happens
once and the source survives across app restarts instead of failing until
it is removed and re-added. The fallback triggers only on
`keyring::Error::NoEntry` (via `credentials::get_credential_if_exists`);
a locked or unreachable keychain still errors, so a transient failure can
never silently switch which password is sent. Sources added manually with
a username that isn't a stored mail account get no fallback: the error
tells the user to remove and re-add the calendar. The fallback also
refuses an OAuth account's mail credential — that's a refresh-token blob,
not a password, and must never be sent as Basic auth to whatever host the
source URL names — so those sources error with the same re-add
instruction instead.

`CalendarView.tsx`'s `friendlyError()` maps raw transport/server error text
to plain-English messages (401/403/404/DNS/TLS substrings each get their
own explanation) and falls back to a generic "check your URL and
credentials" message for anything unmatched. That fallback used to also
swallow `resolve_source_password`'s own already-actionable "...remove and
re-add the calendar" text on an account that otherwise looks connected
(e.g. after a keychain entry disappears), showing the generic message
instead of the specific instruction. `friendlyError` now special-cases
that substring and surfaces the backend's own message instead of masking
it.

### UUID generation

UUIDs for new events use `rand::rngs::OsRng` with manual RFC 4122 version 4
bit-setting rather than the `uuid` crate, to avoid adding a dependency. The
format is `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` where `y` is `8`, `9`, `a`,
or `b`.

## Cache schema

Two tables in the SQLCipher database (see `cache.rs`):

```sql
CREATE TABLE IF NOT EXISTS caldav_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    url TEXT NOT NULL,
    display_name TEXT,
    username TEXT NOT NULL,
    color TEXT,
    last_synced_at TEXT,
    UNIQUE(account_id, url)
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    uid TEXT NOT NULL,
    href TEXT NOT NULL,
    etag TEXT,
    summary TEXT,
    description TEXT,
    location TEXT,
    dtstart TEXT,
    dtend TEXT,
    organizer TEXT,
    status TEXT,
    rrule TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    raw_ics TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    UNIQUE(source_id, uid)
);
```

`dtstart`/`dtend` are stored as-is from the ICS (iCal compact format, or
all-day date strings). Filtering by date in `list_calendar_events_db` does a
string comparison against the `from_date`/`to_date` parameters — callers must
pass the same format for the comparison to be meaningful.

`purge_stale_calendar_events` uses a dynamic `NOT IN (...)` clause built with
boxed `ToSql` params. Events from the source that aren't in the freshly synced
UID set are deleted.

## Tauri commands

| Command | Description |
|---|---|
| `add_caldav_source` | Validate, persist, keychain-store password, initial sync |
| `list_caldav_sources` | All sources from cache |
| `delete_caldav_source` | Keychain delete + events + source row |
| `sync_caldav` | Full PROPFIND→GET→upsert→purge cycle |
| `discover_caldav` | RFC 6764 discovery without persisting |
| `list_calendar_events` | Cache read, optional source_id/date filters |
| `create_event` | PUT new .ics + cache insert |
| `update_event` | PUT with If-Match (increments SEQUENCE) + cache update |
| `delete_event` | DELETE + cache delete |

## Frontend

- `src/lib/caldav.ts` — TypeScript wrappers for all 9 commands, with
  `isTauri()` guards (non-Tauri returns empty arrays / throws)
- `src/components/CalDavSettings.tsx` — Settings panel: source list with
  Sync/Remove buttons, RFC 6764 discovery flow, add-source form, upcoming
  events list (next 90 days)
- Wired into `SettingsModal.tsx` as a new "Calendar" category

## Tests

Unit tests in `caldav.rs` cover: VEVENT extraction, UID skip, multi-event
ICS, line unfolding, TZID param stripping, `iso_to_ical` conversions,
VCALENDAR generation, PROPFIND XML parsing, and UUID format. All run in the
default `cargo test` pass with no network dependency.

The live integration test stub (`syncs_events_from_a_live_caldav_server`) is
marked `#[ignore]` and needs a running CalDAV server (Radicale or Nextcloud
work well for local testing).

## What's not implemented

- **REPORT (calendar-query)**: PROPFIND Depth:1 is simpler and sufficient for
  small calendars. For large calendars a `REPORT` with date range filter would
  cut the GET count significantly.
- **WebDAV sync-collection (RFC 6578)**: Incremental sync (only changed items)
  rather than full collection scan. Worth adding once REPORT is in.
- **VTODO / VJOURNAL**: Only VEVENTs are parsed and stored. Task/journal
  support would need new cache tables and UI.
- **iCalendar attachments**: ATTACH properties are ignored.
- **Recurring event expansion**: RRULE is stored as a string but not expanded
  into individual occurrences for display.
- **Calendar write-back from email invites**: `ics.rs` handles parsing invites
  from email and sending a reply, but does not yet write an accepted invite
  back into a CalDAV calendar.

## Event reminders (added later)

Desktop notifications before events start. No backend scheduler: App.tsx
runs a per-minute check over `list_calendar_events` (cache-only, no
network), normalizes `dtstart` via `icalToIso`, and fires one
notification per event when its start enters the configured lead window
(Settings > Notifications: 5/10/15/30 minutes; stored in localStorage and
read at check time so changes apply live). All-day events (date-only
`dtstart`) are skipped. A slow 15-minute loop re-syncs every CalDAV
source so the cached events reminders read from stay fresh. Each event
notifies at most once per app run (an in-memory keyed set).

## Calendar UI additions (2026-07-06)

All in `CalendarView.tsx` unless noted:

- **24-hour time everywhere.** Event times in the day detail, reminder
  notifications, and the edit form render through
  `toLocaleTimeString(..., { hour12: false })` -- never AM/PM, regardless
  of OS locale.
- **All-day events.** The add-task form has an "All day" pill that hides
  the time inputs. All-day events are written per RFC 5545 as bare dates:
  `DTSTART;VALUE=DATE:<day>` with an exclusive `DTEND;VALUE=DATE:<next
  day>` -- `build_vcalendar` (caldav.rs) adds the `VALUE=DATE` parameter
  whenever the value is an 8-character date, since the property otherwise
  defaults to DATE-TIME. The day detail shows them as "All day".
- **Per-calendar colors.** The `color` column on `caldav_sources` (always
  in the schema, previously unused) is now user-editable: a legend row
  under the calendar header shows one chip per source, and clicking it
  opens a palette (`EXTENDED_PALETTE` from the theme, deliberately
  including muted rows, plus a native custom color input). Persisted via
  the `update_caldav_source_color` command; purely a local display
  preference, never written to the server. Event chips in the grid and
  the detail's left border tint by their source's color, falling back to
  the app accent when unset.
- **Edit and delete.** Each event in the day detail has Edit/Delete
  actions. Edit reuses the add-task form pre-filled (title, date,
  times/all-day, location, RRULE mapped back to the repeat pills, or
  "custom" for anything more complex) and submits through `update_event`
  (same UID, SEQUENCE+1, If-Match on the cached ETag). The reminder
  picker is hidden while editing because `update_event` rebuilds the ICS
  without a VALARM -- offering it would lie. Delete goes through
  `delete_event` and reloads.
- **Creation is synchronous with the server.** `create_event` PUTs to the
  CalDAV server first and only then caches locally -- a task that appears
  in the grid is already on the server, not queued. The command (like the
  rest of the DAV commands) now runs on the blocking pool, so a slow
  server no longer freezes the window (see architecture.md's main-thread
  section).

## Add-form ergonomics and removal placement (2026-07-07)

The add-calendar forms (calendar tab and Settings > Calendar) pre-fill
the server as `mail.<domain>:2080`, derived by regex from the username's
email domain -- the common self-hosted layout this project targets. It's
only a guess: the field stays editable, and a manually-typed server is
never overwritten (the autofill only replaces an empty field or its own
previous guess as the email is typed).

Calendar *removal* was moved out of the sidebar (its per-row x was one
misclick from deleting a calendar) and now lives only in Settings >
Calendar's source list; that delete emits `sources-changed` on the
calendar bus so the sidebar list and any open calendar tab refresh.
