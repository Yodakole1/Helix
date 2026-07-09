# CardDAV contact sync

CardDAV (RFC 4791) is an HTTP-based protocol for syncing contact lists.
Servers expose a collection of vCard objects; clients fetch them over HTTPS
using a subset of the WebDAV protocol (PROPFIND to list resources, GET to
fetch individual vCards).

This doc describes what needs to be built. Nothing in this doc is implemented
yet.

## Scope

- **Pull contacts from a CardDAV server** and upsert them into the existing
  `contacts` table — the same table already built up from harvesting addresses
  seen in mail. CardDAV contacts and harvested contacts are unified, not kept
  in separate silos.
- **Manage CardDAV sources** (add / list / delete) in a new `carddav_sources`
  table. Credentials stored in the OS keychain, not in the cache DB.
- **Manual sync trigger** from the frontend. No background/IDLE-style sync for
  now (that requires a long-lived network connection and scheduling, out of
  scope here).
- **Auto-sync on add** — when a source is added, trigger an immediate sync.

Explicitly out of scope for the initial implementation:
- Push changes back (creating/updating/deleting contacts on the server). The
  `contacts` table is append-oriented with no origin tracking; merging local
  edits back to the server requires a more complex schema and conflict
  resolution story.
- OAuth2 authentication (needed for Google Contacts and iCloud). HTTP Basic
  over HTTPS covers custom-domain setups — Helix's target audience. OAuth2
  can be added later.
- Delta sync / ETag-based incremental updates. A full re-fetch every sync is
  simpler and sufficient until contacts grow into the thousands.
- vCard 4.0 (`VERSION:4.0`). vCard 3.0 is the dominant format in practice.
  Both have the same `FN`/`EMAIL` lines that Helix needs.
- CalDAV (calendars). Similar protocol but a separate feature.

## Crates

- **`reqwest`** (already in `Cargo.toml`) — HTTP client with async/Tokio
  support. Used for all CardDAV HTTP calls.
- **`quick-xml`** — event-based XML parser, used to parse WebDAV PROPFIND
  responses. Lightweight and widely used in Rust WebDAV clients.
  License: MIT. Add: `quick-xml = "0.37"`.
- **vCard parsing** — hand-rolled, same approach as the ICS parser
  (`src-tauri/src/ics.rs`). Helix needs only two vCard properties:
  `FN` (full name) and `EMAIL` (one or more). A minimal parser for those
  two properties is ~40 lines and avoids a dependency with uncertain
  maintenance. If full vCard round-trip fidelity is needed later, swap in
  `vcard4` or `vcard-parser`.

## Schema

One new table in `cache.rs::ensure_schema`:

```sql
CREATE TABLE IF NOT EXISTS carddav_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT NOT NULL,
    url          TEXT NOT NULL,    -- the addressbook collection URL, after discovery
    display_name TEXT,             -- human label for the management UI
    username     TEXT NOT NULL,    -- stored here (not secret); password in keychain
    last_synced_at TEXT,           -- ISO 8601, NULL = never synced
    UNIQUE(account_id, url)
);
```

The credential key for the OS keychain follows the same convention as IMAP
credentials: `carddav__{id}` (using the auto-increment primary key) under
service `dev.helix.app`. The password is never stored in the DB.

Synced contacts land in the existing `contacts` table with no schema change:
`(email TEXT PRIMARY KEY, display_name TEXT, last_seen_at TEXT)`. A vCard with
multiple `EMAIL` lines produces one row per email address, all sharing the
same `FN` as `display_name`. Upsert via the existing `cache::upsert_contacts`
function — no conflict between harvested and CardDAV-synced contacts, since
they merge by email key.

## Protocol flow

### 1. Discovery (done once, when the user adds a source)

Given a URL entered by the user:
- If the user provides a full addressbook URL (e.g., copied from their server's
  admin panel), use it directly as the collection URL.
- If the user provides just a server base URL or email address, attempt
  RFC 6764 discovery:
  1. Try `GET https://{host}/.well-known/carddav` — most servers redirect this
     to the principal URL.
  2. From the principal URL, send `PROPFIND` with depth `0` and request the
     `{urn:ietf:params:xml:ns:carddav}addressbook-home-set` property.
  3. From the addressbook home, send `PROPFIND` with depth `1` and
     `{DAV:}resourcetype` + `{DAV:}displayname` to list available addressbooks.
  4. If exactly one addressbook is found, use its URL automatically; if
     multiple, surface them to the frontend to let the user pick (return the
     list from `add_carddav_source` before committing).

For simplicity in the first implementation, the discovery step can be optional:
accept a user-supplied collection URL and skip auto-discovery. Add discovery
as a polish step once the basic sync works.

### 2. List resources (PROPFIND, Depth: 1)

```xml
PROPFIND {collection_url} HTTP/1.1
Depth: 1
Content-Type: application/xml; charset="utf-8"

<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>
```

The 207 Multi-Status response lists `<D:response>` elements, one per resource.
Parse out `<D:href>` (the resource URL) and `<D:getetag>` for each entry
with `content-type: text/vcard` or `getcontenttype` containing `vcard`.

### 3. Fetch vCards (GET)

For each resource URL from the PROPFIND, `GET {resource_url}` returns the
raw vCard text. Parse with the hand-rolled parser to extract contacts.

In the initial implementation, fetch all resources on every sync (no ETag
delta tracking). This is fine for typical personal addressbooks (hundreds
of contacts). ETag caching — store the last-seen ETag per URL in a new
`carddav_etags` table, skip GET if unchanged — can be added later to make
large addressbooks faster.

### 4. Upsert contacts

For each `(email, display_name)` pair extracted from all vCards, call
`cache::upsert_contacts(conn, &pairs)`. Update `last_synced_at` on the
`carddav_sources` row.

## Tauri commands (`carddav.rs`)

```
add_carddav_source(
    account_id: String,
    url: String,
    username: String,
    password: String,
    display_name: Option<String>,
) -> Result<CardDavSource, String>
```
Stores the credential in the keychain under `carddav__{id}`. Inserts a row
into `carddav_sources`. Immediately calls `sync_carddav_source` internally
and returns the source info (including `last_synced_at` after the first sync).
Roll back the keychain entry if the DB insert fails; roll back both if the
initial sync fails (same error-on-bad-credential pattern as `add_account`).

```
list_carddav_sources() -> Result<Vec<CardDavSource>, String>
```
`CardDavSource`: `{ id, account_id, url, display_name, username,
last_synced_at }`. No password in the return value.

```
delete_carddav_source(id: i64) -> Result<(), String>
```
Deletes the keychain entry (`carddav__{id}`) and the DB row. Does not delete
any contacts that were synced from this source — contacts are shared with
the rest of the address book. (There is no `origin` tracking that would let
us know which contacts came from this source vs. harvesting.)

```
sync_carddav(id: i64) -> Result<SyncResult, String>
```
Resolves the password via `resolve_source_password` (not a raw keychain
read): a missing `carddav__{id}` entry falls back to the owning account's
mail credential and re-stores it under the source's own key — the same
one-time self-heal as `caldav::resolve_source_password`, and with the same
guarantee that only `keyring::Error::NoEntry` triggers the fallback, never
a locked or unreachable keychain (and the same refusal to fall back to an
OAuth account's credential blob, which is not a password). Then runs the full PROPFIND + GET loop,
upserts contacts, updates `last_synced_at`. `SyncResult`:
`{ contacts_added: u32, contacts_updated: u32 }` (counts from the upsert
operation — "added" = new email key, "updated" = existing key with a new
`display_name` or `last_seen_at`).

```
discover_carddav(host: String, username: String, password: String)
    -> Result<Vec<CardDavDiscoveredBook>, String>
```
Runs the RFC 6764 discovery flow and returns the list of addressbook
collections found without persisting anything.
`CardDavDiscoveredBook`: `{ url, display_name }`.
The frontend can show a picker, then call `add_carddav_source` with the
chosen URL.

## HTTP client setup

```rust
let client = reqwest::Client::builder()
    .user_agent("Helix/1.0")
    .build()
    .map_err(|e| e.to_string())?;

let response = client
    .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
    .basic_auth(&username, Some(&password))
    .header("Depth", "1")
    .header("Content-Type", "application/xml; charset=\"utf-8\"")
    .body(PROPFIND_BODY)
    .send()
    .await
    .map_err(|e| e.to_string())?;
```

`reqwest` already appears in `Cargo.toml` (used for WKD PGP key discovery).
No new HTTP crate needed.

## vCard parser

Hand-roll a minimal parser following the same pattern as `ics.rs`:

```rust
fn unfold_vcard(input: &str) -> String {
    // RFC 6350 §3.2: CRLF followed by a single whitespace character is a
    // line fold — remove it to get logical lines.
    input
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")    // servers sometimes send LF-only
        .replace("\n\t", "")
}

fn parse_vcard(text: &str) -> Vec<(String, Option<String>)> {
    // Returns a list of (email, Option<display_name>) pairs.
    // One vCard can have multiple EMAIL lines.
    let unfolded = unfold_vcard(text);
    let mut display_name: Option<String> = None;
    let mut emails: Vec<String> = Vec::new();

    for line in unfolded.lines() {
        let (key_part, value) = match line.split_once(':') {
            Some(pair) => pair,
            None => continue,
        };
        // key_part may include parameters: "EMAIL;TYPE=WORK"
        let key = key_part.split(';').next().unwrap_or("").trim().to_uppercase();
        let value = value.trim();

        match key.as_str() {
            "FN" => display_name = Some(value.to_string()),
            "EMAIL" => {
                if !value.is_empty() {
                    emails.push(value.to_lowercase());
                }
            }
            _ => {}
        }
    }

    emails
        .into_iter()
        .map(|email| (email, display_name.clone()))
        .collect()
}
```

`N` (structured name: last;first;middle;prefix;suffix) is skipped — `FN`
is the display-ready string and always present in vCard 3.0+. Multiple `EMAIL`
properties on one vCard produce multiple rows in `contacts`, each sharing the
same `FN`.

## PROPFIND XML parsing

Use `quick-xml`'s event reader to extract `<D:href>` from each `<D:response>`.
Avoid a full DOM parse — only two fields per response element are needed:

```rust
use quick_xml::events::Event;
use quick_xml::Reader;

fn parse_propfind_hrefs(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut hrefs = Vec::new();
    let mut inside_href = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"href" => {
                inside_href = true;
            }
            Ok(Event::Text(e)) if inside_href => {
                hrefs.push(e.unescape().unwrap_or_default().into_owned());
                inside_href = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    hrefs
}
```

Filter out the collection URL itself (servers include it as the first response
element) and non-vCard entries (check that the URL ends in `.vcf` or that
`content-type` contains `vcard`).

## Credential storage

Same pattern as IMAP/SMTP/POP3 credentials:

```rust
credentials::store_credential(&format!("carddav__{id}"), &password)?;
```

On delete:
```rust
credentials::delete_credential(&format!("carddav__{id}"))?;
```

On sync:
```rust
let password = credentials::get_credential(&format!("carddav__{id}"))?;
```

Credentials are never stored in `carddav_sources` — the DB row has only the
username (non-secret, needed for the Basic auth header) and the opaque `id`
used to look up the keychain entry.

## Implementation sequence

1. Add `quick-xml = "0.37"` to `Cargo.toml`.
2. Add the `carddav_sources` table to `cache.rs::ensure_schema`.
3. Write `carddav.rs` — `add_carddav_source`, `list_carddav_sources`,
   `delete_carddav_source`, `sync_carddav`. Start with a hardcoded collection
   URL (no discovery) to get the PROPFIND → GET → upsert pipeline working
   end-to-end.
4. Add `mod carddav` to `lib.rs` and register the commands.
5. Unit tests for `parse_vcard` and `parse_propfind_hrefs` — no network
   needed, just string inputs. Integration test against a live CardDAV
   server requires network (mark `#[ignore]`). Baïkal and Radicale are
   both easy to run locally via Docker for this.
6. Add `discover_carddav` once the basic sync is solid.

## Testing

Unit tests (no network, run in default `cargo test`):
- `parse_vcard`: single EMAIL, multiple EMAILs, missing FN, parameterized
  key (`EMAIL;TYPE=WORK:`), folded lines, vCard 4.0 input.
- `parse_propfind_hrefs`: a minimal 207 Multi-Status XML string, collection
  URL filtered out, only `.vcf` hrefs returned.

Integration test (needs network, `#[ignore]`):
- Stand up Baïkal or Radicale via Docker, seed a test addressbook with a few
  vCards, call `sync_carddav`, assert the contacts appear in the cache.

## Limitations

- No push (read-only). Contacts edited in Helix won't propagate back to the
  server.
- No delta sync. Every sync re-fetches all vCards. For an addressbook with
  thousands of entries this is slow; add ETag tracking later.
- No OAuth2. Custom-domain setups using CardDAV typically support HTTP Basic.
  Google Contacts and iCloud require OAuth2 — deferred.
- No conflict resolution. If the same email address is both harvested from
  mail and synced from CardDAV, the `display_name` from whichever was seen
  last wins. This is almost always fine in practice.
- No multi-addressbook picker in the initial `add_carddav_source` command.
  If a server has multiple addressbooks, the user must supply the specific
  collection URL. `discover_carddav` is the path to a nicer picker UI.
