use chrono::Utc;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

use crate::cache;
use crate::credentials;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CalDavSource {
    pub id: i64,
    pub account_id: String,
    pub url: String,
    pub display_name: Option<String>,
    pub username: String,
    pub color: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CalDavSyncResult {
    pub events_added: u32,
    pub events_updated: u32,
    pub events_deleted: u32,
}

#[derive(Debug, Serialize)]
pub struct CalDavDiscoveredCalendar {
    pub url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CalendarEvent {
    pub id: i64,
    pub source_id: i64,
    pub uid: String,
    pub href: String,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub dtstart: Option<String>,
    pub dtend: Option<String>,
    pub organizer: Option<String>,
    pub status: Option<String>,
    pub rrule: Option<String>,
    pub synced_at: String,
}

// ── ICS parsing ───────────────────────────────────────────────────────────────

struct ParsedEvent {
    uid: String,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    dtstart: Option<String>,
    dtend: Option<String>,
    organizer: Option<String>,
    status: Option<String>,
    rrule: Option<String>,
    sequence: i64,
}

// RFC 5545 line folding: CRLF + single whitespace = continuation, strip it.
fn unfold_ics(input: &str) -> String {
    input
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "")
}

/// Parses all VEVENTs from a VCALENDAR ICS text. Returns one entry per
/// VEVENT. Events without a UID are skipped (no stable key for storage).
fn parse_vevents(ics: &str) -> Vec<ParsedEvent> {
    let unfolded = unfold_ics(ics);
    let mut events = Vec::new();
    let mut current: Option<ParsedEvent> = None;

    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');

        if line == "BEGIN:VEVENT" {
            current = Some(ParsedEvent {
                uid: String::new(),
                summary: None,
                description: None,
                location: None,
                dtstart: None,
                dtend: None,
                organizer: None,
                status: None,
                rrule: None,
                sequence: 0,
            });
            continue;
        }

        if line == "END:VEVENT" {
            if let Some(ev) = current.take() {
                if !ev.uid.is_empty() {
                    events.push(ev);
                }
            }
            continue;
        }

        let ev = match current.as_mut() {
            Some(e) => e,
            None => continue,
        };

        let Some((key_part, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let key = key_part.split(';').next().unwrap_or(key_part).trim().to_uppercase();

        match key.as_str() {
            "UID" => ev.uid = value.to_string(),
            "SUMMARY" => ev.summary = Some(value.to_string()),
            "DESCRIPTION" => ev.description = Some(value.to_string()),
            "LOCATION" => ev.location = Some(value.to_string()),
            "DTSTART" => ev.dtstart = Some(value.to_string()),
            "DTEND" => ev.dtend = Some(value.to_string()),
            "RRULE" => ev.rrule = Some(value.to_string()),
            "STATUS" => ev.status = Some(value.to_string()),
            "SEQUENCE" => ev.sequence = value.parse().unwrap_or(0),
            "ORGANIZER" => {
                ev.organizer = Some(value.trim_start_matches("mailto:").to_string());
            }
            _ => {}
        }
    }

    events
}

// ── ICS generation ────────────────────────────────────────────────────────────

/// Returns the current UTC instant in iCal format: `20260701T100000Z`.
fn now_ical() -> String {
    Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Converts an ISO 8601 datetime like `"2026-07-01T10:00:00Z"` or a
/// date `"2026-07-01"` to iCal compact format (`"20260701T100000Z"` or
/// `"20260701"`). Passthrough for strings already in iCal format.
fn iso_to_ical(dt: &str) -> String {
    // Already in iCal format (no hyphens in the date part, or all-day without them).
    if !dt.contains('-') || (dt.len() == 8 && !dt.contains('T')) {
        return dt.to_string();
    }
    // All-day date: "2026-07-01" → "20260701"
    if dt.len() == 10 && !dt.contains('T') {
        return dt.replace('-', "");
    }
    // Datetime: strip hyphens and colons, keep Z/offset.
    dt.replace('-', "").replace(':', "").replace('T', "T")
}

/// Generates a VCALENDAR wrapping one VEVENT. `sequence` should be 0 for
/// new events and incremented by 1 for each update.
fn build_vcalendar(ev: &ParsedEvent, sequence: i64, reminder_minutes_before: Option<i64>) -> String {
    let mut cal = String::new();
    cal.push_str("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Helix Mail//EN\r\n");
    cal.push_str("BEGIN:VEVENT\r\n");
    cal.push_str(&format!("UID:{}\r\n", ev.uid));
    cal.push_str(&format!("DTSTAMP:{}\r\n", now_ical()));
    cal.push_str(&format!("SEQUENCE:{sequence}\r\n"));
    if let Some(s) = &ev.dtstart {
        cal.push_str(&format!("DTSTART:{}\r\n", iso_to_ical(s)));
    }
    if let Some(s) = &ev.dtend {
        cal.push_str(&format!("DTEND:{}\r\n", iso_to_ical(s)));
    }
    if let Some(s) = &ev.summary {
        cal.push_str(&format!("SUMMARY:{s}\r\n"));
    }
    if let Some(s) = &ev.description {
        cal.push_str(&format!("DESCRIPTION:{s}\r\n"));
    }
    if let Some(s) = &ev.location {
        cal.push_str(&format!("LOCATION:{s}\r\n"));
    }
    if let Some(s) = &ev.rrule {
        cal.push_str(&format!("RRULE:{s}\r\n"));
    }
    if let Some(s) = &ev.organizer {
        cal.push_str(&format!("ORGANIZER:mailto:{s}\r\n"));
    }
    if let Some(s) = &ev.status {
        cal.push_str(&format!("STATUS:{s}\r\n"));
    }
    // RFC 5545 VALARM: a display reminder N minutes before the event
    // starts. Minutes are the universal unit here -- "-PT1440M" is a valid
    // spelling of "one day before", so no unit juggling is needed.
    if let Some(minutes) = reminder_minutes_before {
        if minutes > 0 {
            cal.push_str("BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\n");
            cal.push_str(&format!("TRIGGER:-PT{minutes}M\r\n"));
            cal.push_str("END:VALARM\r\n");
        }
    }
    cal.push_str("END:VEVENT\r\nEND:VCALENDAR\r\n");
    cal
}

// ── XML parsing helpers ───────────────────────────────────────────────────────

/// Extracts `(href, etag)` pairs from a WebDAV 207 Multi-Status response.
/// Etag is `None` when the propstat didn't include one.
fn parse_propfind_resources(xml: &str) -> Vec<(String, Option<String>)> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut results = Vec::new();
    let mut in_response = false;
    let mut in_href = false;
    let mut in_etag = false;
    let mut current_href: Option<String> = None;
    let mut current_etag: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"response" => {
                    in_response = true;
                    current_href = None;
                    current_etag = None;
                }
                b"href" if in_response => { in_href = true; }
                b"getetag" if in_response => { in_etag = true; }
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"response" if in_response => {
                    if let Some(href) = current_href.take() {
                        results.push((href, current_etag.take()));
                    }
                    in_response = false;
                }
                b"href" => { in_href = false; }
                b"getetag" => { in_etag = false; }
                _ => {}
            },
            Ok(Event::Text(e)) => {
                if let Ok(text) = e.unescape() {
                    // ETags are quoted; strip the surrounding quotes.
                    let s = text.trim_matches('"').to_string();
                    if in_href && !s.is_empty() {
                        current_href = Some(s);
                    } else if in_etag && !s.is_empty() {
                        current_etag = Some(s);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    results
}

/// Extracts all `<D:displayname>` text values in document order.
fn parse_displaynames(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut names = Vec::new();
    let mut inside = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"displayname" => {
                inside = true;
            }
            Ok(Event::Text(e)) if inside => {
                if let Ok(text) = e.unescape() {
                    names.push(text.into_owned());
                }
                inside = false;
            }
            Ok(Event::End(_)) if inside => { inside = false; }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    names
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

fn make_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Helix/1.0")
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

fn propfind(
    client: &reqwest::blocking::Client,
    url: &str,
    username: &str,
    password: &str,
    body: &str,
    depth: &str,
) -> Result<String, String> {
    let resp = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").expect("valid method"),
            url,
        )
        .basic_auth(username, Some(password))
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=\"utf-8\"")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("PROPFIND {url} failed: {e}"))?;

    if !resp.status().is_success() && resp.status().as_u16() != 207 {
        return Err(format!("PROPFIND {url} returned HTTP {}", resp.status()));
    }
    resp.text().map_err(|e| format!("could not read PROPFIND response: {e}"))
}

/// GETs an ICS resource. Returns `(body, etag)`.
fn get_ics(
    client: &reqwest::blocking::Client,
    url: &str,
    username: &str,
    password: &str,
) -> Result<(String, Option<String>), String> {
    let resp = client
        .get(url)
        .basic_auth(username, Some(password))
        .header("Accept", "text/calendar")
        .send()
        .map_err(|e| format!("GET {url} failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {url} returned HTTP {}", resp.status()));
    }

    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());

    let body = resp.text().map_err(|e| format!("could not read ICS body: {e}"))?;
    Ok((body, etag))
}

/// PUTs an ICS resource. `etag_if_match` is sent as `If-Match` for updates
/// (conditional to avoid clobbering concurrent changes); `None` for creates.
/// Returns the new ETag from the response headers, if the server sends one.
fn put_ics(
    client: &reqwest::blocking::Client,
    url: &str,
    username: &str,
    password: &str,
    body: &str,
    etag_if_match: Option<&str>,
) -> Result<Option<String>, String> {
    let mut req = client
        .put(url)
        .basic_auth(username, Some(password))
        .header("Content-Type", "text/calendar; charset=utf-8");

    if let Some(etag) = etag_if_match {
        req = req.header("If-Match", format!("\"{etag}\""));
    } else {
        req = req.header("If-None-Match", "*");
    }

    let resp = req
        .body(body.to_string())
        .send()
        .map_err(|e| format!("PUT {url} failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("PUT {url} returned HTTP {}", resp.status()));
    }

    let new_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());

    Ok(new_etag)
}

fn http_delete(
    client: &reqwest::blocking::Client,
    url: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let resp = client
        .delete(url)
        .basic_auth(username, Some(password))
        .send()
        .map_err(|e| format!("DELETE {url} failed: {e}"))?;

    // 204 No Content is the normal success; 404 means already gone.
    if resp.status().is_success() || resp.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(format!("DELETE {url} returned HTTP {}", resp.status()))
    }
}

// ── PROPFIND / REPORT bodies ──────────────────────────────────────────────────

const PROPFIND_EVENTS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>"#;

const PROPFIND_HOME: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>"#;

const PROPFIND_CALENDARS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
  </D:prop>
</D:propfind>"#;

// ── Core sync logic ───────────────────────────────────────────────────────────

fn base_url_of(url: &str) -> String {
    url.split_once("://")
        .and_then(|(scheme, rest)| rest.split_once('/').map(|(host, _)| format!("{scheme}://{host}")))
        .unwrap_or_else(|| url.to_string())
}

// Resolves a PROPFIND-reported resource href against the collection URL the
// user actually configured. An absolute href is only accepted when it shares
// the collection's origin (scheme + host + port) -- otherwise a compromised
// or malicious server could point a resource at an arbitrary third-party
// host, and since every resource fetch reattaches this account's Basic-Auth
// credentials (see `get_ics`/`put_ics`/`http_delete`), resolving it blindly
// would leak the password to that host on every background sync. Returns
// `None` for an out-of-origin href so the caller can skip that resource.
fn resolve_href(href: &str, collection_url: &str) -> Option<String> {
    if href.starts_with("http://") || href.starts_with("https://") {
        if base_url_of(href).eq_ignore_ascii_case(&base_url_of(collection_url)) {
            Some(href.to_string())
        } else {
            None
        }
    } else if href.starts_with('/') {
        Some(format!("{}{href}", base_url_of(collection_url)))
    } else {
        Some(format!("{}/{href}", collection_url.trim_end_matches('/')))
    }
}

fn do_sync(
    client: &reqwest::blocking::Client,
    collection_url: &str,
    username: &str,
    password: &str,
    source_id: i64,
    conn: &rusqlite::Connection,
) -> Result<CalDavSyncResult, String> {
    let propfind_body = propfind(client, collection_url, username, password, PROPFIND_EVENTS, "1")?;
    let resources = parse_propfind_resources(&propfind_body);

    let ics_resources: Vec<(String, Option<String>)> = resources
        .into_iter()
        .filter(|(href, _)| href.to_lowercase().ends_with(".ics"))
        .collect();

    let now = Utc::now().to_rfc3339();
    let mut added = 0u32;
    let mut updated = 0u32;
    let mut synced_uids: Vec<String> = Vec::new();

    for (href, server_etag) in &ics_resources {
        let Some(resource_url) = resolve_href(href, collection_url) else {
            log::warn!("CalDAV resource href {href} is outside {collection_url}'s origin; skipping");
            continue;
        };

        let (ics_body, fetched_etag) = match get_ics(client, &resource_url, username, password) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("CalDAV GET {resource_url} failed: {e}");
                continue;
            }
        };

        let effective_etag = fetched_etag.as_deref().or(server_etag.as_deref());

        for ev in parse_vevents(&ics_body) {
            synced_uids.push(ev.uid.clone());
            match cache::upsert_calendar_event(
                conn,
                source_id,
                &ev.uid,
                &resource_url,
                effective_etag,
                ev.summary.as_deref(),
                ev.description.as_deref(),
                ev.location.as_deref(),
                ev.dtstart.as_deref(),
                ev.dtend.as_deref(),
                ev.organizer.as_deref(),
                ev.status.as_deref(),
                ev.rrule.as_deref(),
                ev.sequence,
                &ics_body,
                &now,
            ) {
                Ok(true) => added += 1,
                Ok(false) => updated += 1,
                Err(e) => log::warn!("could not upsert event {}: {e}", ev.uid),
            }
        }
    }

    let deleted = cache::purge_stale_calendar_events(conn, source_id, &synced_uids)
        .unwrap_or_else(|e| { log::warn!("could not purge stale events: {e}"); 0 });

    Ok(CalDavSyncResult { events_added: added, events_updated: updated, events_deleted: deleted })
}

// ── Helper: map cache record to public type ───────────────────────────────────

fn to_event(r: cache::CalendarEventRecord) -> CalendarEvent {
    CalendarEvent {
        id: r.id,
        source_id: r.source_id,
        uid: r.uid,
        href: r.href,
        summary: r.summary,
        description: r.description,
        location: r.location,
        dtstart: r.dtstart,
        dtend: r.dtend,
        organizer: r.organizer,
        status: r.status,
        rrule: r.rrule,
        synced_at: r.synced_at,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Resolves the password for a stored CalDAV source. It normally lives in
/// the OS keychain under `caldav__{id}`; if that entry has gone missing
/// (a cleaned-out keychain, an entry that never landed), fall back to the
/// owning account's mail credential — sources connected during account
/// onboarding authenticate with exactly that password — and re-store it
/// under the source's own key so the heal happens once. Only a genuinely
/// absent entry falls back; a locked or unreachable keychain still errors,
/// so a transient failure can't silently switch which password gets sent.
fn resolve_source_password(record: &cache::CalDavSourceRecord) -> Result<String, String> {
    let key = format!("caldav__{}", record.id);
    if let Some(password) = credentials::get_credential_if_exists(&key)? {
        return Ok(password);
    }
    let fallback = credentials::get_credential_if_exists(&record.account_id)?.ok_or_else(|| {
        format!(
            "no stored password for calendar {} and no mail credential for {} to fall back to; remove and re-add the calendar",
            record.id, record.account_id
        )
    })?;
    if let Err(e) = credentials::store_credential(key, fallback.clone()) {
        eprintln!("could not re-store healed CalDAV credential: {e}");
    }
    Ok(fallback)
}

/// Adds a CalDAV source, stores the password in the OS keychain, and runs
/// an initial sync. Rolls back on failure — same pattern as `add_carddav_source`.
#[tauri::command]
pub fn add_caldav_source(
    account_id: String,
    url: String,
    username: String,
    mut password: String,
    display_name: Option<String>,
    color: Option<String>,
) -> Result<CalDavSource, String> {
    let client = make_client()?;

    // Validate with a PROPFIND before persisting anything.
    propfind(&client, &url, &username, &password, PROPFIND_EVENTS, "0")
        .map_err(|e| format!("could not reach CalDAV server at {url}: {e}"))?;

    let conn = cache::open()?;
    let id = cache::insert_caldav_source(
        &conn, &account_id, &url, display_name.as_deref(), &username, color.as_deref(),
    )?;

    let key = format!("caldav__{id}");
    credentials::store_credential(key.clone(), password.clone()).map_err(|e| {
        let _ = cache::delete_caldav_source_db(&conn, id);
        e
    })?;

    let result = do_sync(&client, &url, &username, &password, id, &conn);
    use zeroize::Zeroize;
    password.zeroize();

    match result {
        Ok(_) => {
            let ts = Utc::now().to_rfc3339();
            cache::update_caldav_synced(&conn, id, &ts).ok();
            let record = cache::get_caldav_source(&conn, id)?
                .ok_or_else(|| format!("could not reload CalDAV source {id} after insert"))?;
            Ok(CalDavSource {
                id: record.id,
                account_id: record.account_id,
                url: record.url,
                display_name: record.display_name,
                username: record.username,
                color: record.color,
                last_synced_at: record.last_synced_at,
            })
        }
        Err(e) => {
            let _ = credentials::delete_credential(key);
            let _ = cache::delete_caldav_source_db(&conn, id);
            Err(format!("initial CalDAV sync failed: {e}"))
        }
    }
}

#[tauri::command]
pub fn list_caldav_sources() -> Result<Vec<CalDavSource>, String> {
    let conn = cache::open()?;
    Ok(cache::list_caldav_sources_db(&conn)?
        .into_iter()
        .map(|r| CalDavSource {
            id: r.id,
            account_id: r.account_id,
            url: r.url,
            display_name: r.display_name,
            username: r.username,
            color: r.color,
            last_synced_at: r.last_synced_at,
        })
        .collect())
}

/// Deletes the keychain credential, all synced events, and the DB row.
#[tauri::command]
pub fn delete_caldav_source(id: i64) -> Result<(), String> {
    let key = format!("caldav__{id}");
    credentials::delete_credential(key).ok();
    let conn = cache::open()?;
    cache::delete_caldav_source_db(&conn, id)
}

/// Re-fetches all ICS resources and upserts them. Removes events that are no
/// longer present on the server. Updates `last_synced_at` on success.
#[tauri::command]
pub fn sync_caldav(id: i64) -> Result<CalDavSyncResult, String> {
    let conn = cache::open()?;
    let record = cache::get_caldav_source(&conn, id)?
        .ok_or_else(|| format!("no CalDAV source with id {id}"))?;

    let password = resolve_source_password(&record)?;

    let client = make_client()?;
    let result = do_sync(&client, &record.url, &record.username, &password, id, &conn)?;

    let ts = Utc::now().to_rfc3339();
    cache::update_caldav_synced(&conn, id, &ts)?;

    Ok(result)
}

/// RFC 6764 discovery: `.well-known/caldav` → principal → calendar-home-set →
/// list calendar collections. Returns URLs without persisting anything.
#[tauri::command]
pub fn discover_caldav(
    host: String,
    username: String,
    password: String,
) -> Result<Vec<CalDavDiscoveredCalendar>, String> {
    let client = make_client()?;

    let base = if host.starts_with("http://") || host.starts_with("https://") {
        host.trim_end_matches('/').to_string()
    } else {
        format!("https://{}", host.trim_end_matches('/'))
    };

    let well_known = format!("{base}/.well-known/caldav");
    let principal_url = client
        .get(&well_known)
        .basic_auth(&username, Some(&password))
        .send()
        .map(|r| r.url().to_string())
        .unwrap_or_else(|_| well_known.clone());

    let home_xml =
        propfind(&client, &principal_url, &username, &password, PROPFIND_HOME, "0")
            .unwrap_or_default();
    let home_hrefs = parse_propfind_resources(&home_xml)
        .into_iter()
        .map(|(href, _)| href)
        .collect::<Vec<_>>();

    let homes: Vec<String> = if home_hrefs.is_empty() {
        vec![principal_url.clone()]
    } else {
        home_hrefs
            .into_iter()
            .map(|h| {
                if h.starts_with("http://") || h.starts_with("https://") {
                    h
                } else {
                    format!("{base}{h}")
                }
            })
            .collect()
    };

    let mut calendars = Vec::new();
    for home_url in &homes {
        let Ok(cals_xml) = propfind(&client, home_url, &username, &password, PROPFIND_CALENDARS, "1") else {
            continue;
        };
        let hrefs = parse_propfind_resources(&cals_xml)
            .into_iter()
            .map(|(href, _)| href)
            .collect::<Vec<_>>();
        let names = parse_displaynames(&cals_xml);

        for (i, href) in hrefs.iter().enumerate() {
            if href == home_url || href.trim_end_matches('/') == home_url.trim_end_matches('/') {
                continue;
            }
            let full_url = if href.starts_with("http://") || href.starts_with("https://") {
                href.clone()
            } else {
                format!("{base}{href}")
            };
            calendars.push(CalDavDiscoveredCalendar {
                url: full_url,
                display_name: names.get(i).cloned(),
            });
        }
    }

    Ok(calendars)
}

/// Lists calendar events from the local cache. `source_id = null` means all
/// sources. `from_date`/`to_date` are compared against `dtstart` as strings,
/// so both should use the same iCal compact format (`"20260701T000000Z"` or
/// `"20260701"`) for the filter to work reliably.
#[tauri::command]
pub fn list_calendar_events(
    source_id: Option<i64>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<CalendarEvent>, String> {
    let conn = cache::open()?;
    Ok(cache::list_calendar_events_db(&conn, source_id, from_date.as_deref(), to_date.as_deref())?
        .into_iter()
        .map(to_event)
        .collect())
}

/// Creates a new event on the CalDAV server and inserts it into the local
/// cache. Generates a UUID for the UID.
#[tauri::command]
pub fn create_event(
    source_id: i64,
    summary: String,
    dtstart: String,
    dtend: String,
    location: Option<String>,
    description: Option<String>,
    rrule: Option<String>,
    reminder_minutes_before: Option<i64>,
) -> Result<CalendarEvent, String> {
    let conn = cache::open()?;
    let record = cache::get_caldav_source(&conn, source_id)?
        .ok_or_else(|| format!("no CalDAV source with id {source_id}"))?;

    let password = resolve_source_password(&record)?;

    let uid = uuid_v4();
    let ev = ParsedEvent {
        uid: uid.clone(),
        summary: Some(summary),
        description,
        location,
        dtstart: Some(dtstart),
        dtend: Some(dtend),
        organizer: None,
        status: Some("CONFIRMED".to_string()),
        rrule,
        sequence: 0,
    };

    let ics = build_vcalendar(&ev, 0, reminder_minutes_before);
    let event_url = format!("{}/{uid}.ics", record.url.trim_end_matches('/'));
    let client = make_client()?;
    let new_etag = put_ics(&client, &event_url, &record.username, &password, &ics, None)?;

    let now = Utc::now().to_rfc3339();
    cache::upsert_calendar_event(
        &conn,
        source_id,
        &uid,
        &event_url,
        new_etag.as_deref(),
        ev.summary.as_deref(),
        ev.description.as_deref(),
        ev.location.as_deref(),
        ev.dtstart.as_deref(),
        ev.dtend.as_deref(),
        ev.organizer.as_deref(),
        ev.status.as_deref(),
        ev.rrule.as_deref(),
        0,
        &ics,
        &now,
    )?;

    cache::get_calendar_event_db(&conn, source_id, &uid)?
        .ok_or_else(|| "event was not stored after PUT".to_string())
        .map(to_event)
}

/// Updates an existing event in place (increments SEQUENCE, sends
/// `If-Match` with the cached ETag for optimistic concurrency).
#[tauri::command]
pub fn update_event(
    source_id: i64,
    uid: String,
    summary: String,
    dtstart: String,
    dtend: String,
    location: Option<String>,
    description: Option<String>,
    rrule: Option<String>,
) -> Result<CalendarEvent, String> {
    let conn = cache::open()?;
    let record = cache::get_caldav_source(&conn, source_id)?
        .ok_or_else(|| format!("no CalDAV source with id {source_id}"))?;
    let existing = cache::get_calendar_event_db(&conn, source_id, &uid)?
        .ok_or_else(|| format!("no event with uid {uid} in source {source_id}"))?;

    let password = resolve_source_password(&record)?;

    let new_sequence = existing.sequence + 1;
    let ev = ParsedEvent {
        uid: uid.clone(),
        summary: Some(summary),
        description,
        location,
        dtstart: Some(dtstart),
        dtend: Some(dtend),
        organizer: existing.organizer.clone(),
        status: existing.status.clone(),
        rrule,
        sequence: new_sequence,
    };

    // Updates don't (yet) manage reminders -- editing an event keeps its
    // fields but drops any alarm; reminder editing is create-time only.
    let ics = build_vcalendar(&ev, new_sequence, None);
    let client = make_client()?;
    let new_etag = put_ics(
        &client, &existing.href, &record.username, &password, &ics,
        existing.etag.as_deref(),
    )?;

    let now = Utc::now().to_rfc3339();
    cache::upsert_calendar_event(
        &conn,
        source_id,
        &uid,
        &existing.href,
        new_etag.as_deref().or(existing.etag.as_deref()),
        ev.summary.as_deref(),
        ev.description.as_deref(),
        ev.location.as_deref(),
        ev.dtstart.as_deref(),
        ev.dtend.as_deref(),
        ev.organizer.as_deref(),
        ev.status.as_deref(),
        ev.rrule.as_deref(),
        new_sequence,
        &ics,
        &now,
    )?;

    cache::get_calendar_event_db(&conn, source_id, &uid)?
        .ok_or_else(|| "event not found after update".to_string())
        .map(to_event)
}

/// Deletes an event from the CalDAV server and removes it from the local cache.
#[tauri::command]
pub fn delete_event(source_id: i64, uid: String) -> Result<(), String> {
    let conn = cache::open()?;
    let record = cache::get_caldav_source(&conn, source_id)?
        .ok_or_else(|| format!("no CalDAV source with id {source_id}"))?;
    let existing = cache::get_calendar_event_db(&conn, source_id, &uid)?
        .ok_or_else(|| format!("no event with uid {uid} in source {source_id}"))?;

    let password = resolve_source_password(&record)?;

    let client = make_client()?;
    http_delete(&client, &existing.href, &record.username, &password)?;
    cache::delete_calendar_event_db(&conn, source_id, &uid)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn uuid_v4() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    // Set version (4) and variant bits per RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes(bytes[0..4].try_into().unwrap()),
        u16::from_be_bytes(bytes[4..6].try_into().unwrap()),
        u16::from_be_bytes(bytes[6..8].try_into().unwrap()),
        u16::from_be_bytes(bytes[8..10].try_into().unwrap()),
        u64::from_be_bytes({
            let mut b = [0u8; 8];
            b[2..].copy_from_slice(&bytes[10..16]);
            b
        }),
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_vevents_extracts_standard_fields() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
                   BEGIN:VEVENT\r\n\
                   UID:test-uid-1@cal.helix.test\r\n\
                   SUMMARY:Team standup\r\n\
                   DTSTART:20260701T100000Z\r\n\
                   DTEND:20260701T103000Z\r\n\
                   LOCATION:Conf room A\r\n\
                   DESCRIPTION:Daily sync\r\n\
                   STATUS:CONFIRMED\r\n\
                   SEQUENCE:2\r\n\
                   ORGANIZER:mailto:boss@example.com\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let events = parse_vevents(ics);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.uid, "test-uid-1@cal.helix.test");
        assert_eq!(ev.summary.as_deref(), Some("Team standup"));
        assert_eq!(ev.dtstart.as_deref(), Some("20260701T100000Z"));
        assert_eq!(ev.dtend.as_deref(), Some("20260701T103000Z"));
        assert_eq!(ev.location.as_deref(), Some("Conf room A"));
        assert_eq!(ev.description.as_deref(), Some("Daily sync"));
        assert_eq!(ev.status.as_deref(), Some("CONFIRMED"));
        assert_eq!(ev.sequence, 2);
        assert_eq!(ev.organizer.as_deref(), Some("boss@example.com"));
    }

    #[test]
    fn parse_vevents_skips_events_without_uid() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\nSUMMARY:No UID\r\nDTSTART:20260701T100000Z\r\nEND:VEVENT\r\n\
                   BEGIN:VEVENT\r\nUID:has-uid\r\nSUMMARY:Has UID\r\nEND:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let events = parse_vevents(ics);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid, "has-uid");
    }

    #[test]
    fn parse_vevents_handles_multiple_events_in_one_ics() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\nUID:ev1\r\nSUMMARY:First\r\nEND:VEVENT\r\n\
                   BEGIN:VEVENT\r\nUID:ev2\r\nSUMMARY:Second\r\nEND:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let events = parse_vevents(ics);
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn parse_vevents_unfolds_long_lines() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   UID:fold-uid\r\n\
                   SUMMARY:A very long su\r\n bject that wraps\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let events = parse_vevents(ics);
        assert_eq!(events[0].summary.as_deref(), Some("A very long subject that wraps"));
    }

    #[test]
    fn parse_vevents_strips_dtstart_tzid_params() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   UID:tz-uid\r\n\
                   DTSTART;TZID=America/New_York:20260701T100000\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let events = parse_vevents(ics);
        assert_eq!(events[0].dtstart.as_deref(), Some("20260701T100000"));
    }

    #[test]
    fn iso_to_ical_converts_iso_datetime() {
        assert_eq!(iso_to_ical("2026-07-01T10:00:00Z"), "20260701T100000Z");
    }

    #[test]
    fn iso_to_ical_converts_all_day_date() {
        assert_eq!(iso_to_ical("2026-07-01"), "20260701");
    }

    #[test]
    fn iso_to_ical_passes_through_already_ical_format() {
        assert_eq!(iso_to_ical("20260701T100000Z"), "20260701T100000Z");
        assert_eq!(iso_to_ical("20260701"), "20260701");
    }

    #[test]
    fn build_vcalendar_produces_valid_structure() {
        let ev = ParsedEvent {
            uid: "test-uid".to_string(),
            summary: Some("Meeting".to_string()),
            dtstart: Some("20260701T100000Z".to_string()),
            dtend: Some("20260701T110000Z".to_string()),
            description: None,
            location: None,
            organizer: None,
            status: None,
            rrule: None,
            sequence: 0,
        };
        let ics = build_vcalendar(&ev, 0, None);
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(ics.contains("UID:test-uid\r\n"));
        assert!(ics.contains("SUMMARY:Meeting\r\n"));
        assert!(ics.contains("DTSTART:20260701T100000Z\r\n"));
        assert!(ics.contains("DTEND:20260701T110000Z\r\n"));
        assert!(ics.contains("SEQUENCE:0\r\n"));
        assert!(!ics.contains("BEGIN:VALARM"));
        assert!(ics.ends_with("END:VEVENT\r\nEND:VCALENDAR\r\n"));
    }

    #[test]
    fn build_vcalendar_emits_valarm_for_reminder() {
        let ev = ParsedEvent {
            uid: "test-uid".to_string(),
            summary: Some("Meeting".to_string()),
            dtstart: Some("20260701T100000Z".to_string()),
            dtend: Some("20260701T110000Z".to_string()),
            description: None,
            location: None,
            organizer: None,
            status: None,
            rrule: Some("FREQ=WEEKLY".to_string()),
            sequence: 0,
        };
        // One day before, expressed in minutes -- the only unit the caller
        // ever sends.
        let ics = build_vcalendar(&ev, 0, Some(1440));
        assert!(ics.contains("RRULE:FREQ=WEEKLY\r\n"));
        assert!(ics.contains("BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT1440M\r\nEND:VALARM\r\n"));
        // The alarm must sit inside the VEVENT, not after it.
        let valarm_pos = ics.find("BEGIN:VALARM").unwrap();
        let vevent_end = ics.find("END:VEVENT").unwrap();
        assert!(valarm_pos < vevent_end);
        // A zero/negative reminder is treated as "no reminder".
        let none = build_vcalendar(&ev, 0, Some(0));
        assert!(!none.contains("BEGIN:VALARM"));
    }

    #[test]
    fn parse_propfind_resources_extracts_hrefs_and_etags() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cal/event1.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"abc123"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/event2.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"def456"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let resources = parse_propfind_resources(xml);
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].0, "/cal/event1.ics");
        assert_eq!(resources[0].1.as_deref(), Some("abc123"));
        assert_eq!(resources[1].0, "/cal/event2.ics");
        assert_eq!(resources[1].1.as_deref(), Some("def456"));
    }

    #[test]
    fn uuid_v4_has_correct_format() {
        let id = uuid_v4();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        // Version 4 and variant bits.
        assert_eq!(&parts[2][0..1], "4");
        let variant_nibble = u8::from_str_radix(&parts[3][0..1], 16).unwrap();
        assert!((8..=11).contains(&variant_nibble));
    }

    #[tokio::test]
    #[ignore = "requires a local CalDAV server — see docs/technical/caldav.md"]
    async fn syncs_events_from_a_live_caldav_server() {
        // Stand up Radicale or Nextcloud, seed a VEVENT, then exercise
        // add_caldav_source / sync_caldav / list_calendar_events against it.
    }

    #[test]
    fn resolve_href_accepts_relative_paths() {
        let resolved = resolve_href("event1.ics", "https://cal.example.com/dav/calendars/me");
        assert_eq!(resolved.as_deref(), Some("https://cal.example.com/dav/calendars/me/event1.ics"));
    }

    #[test]
    fn resolve_href_accepts_absolute_path_same_origin() {
        let resolved = resolve_href("/dav/calendars/me/event1.ics", "https://cal.example.com/dav/calendars/me");
        assert_eq!(resolved.as_deref(), Some("https://cal.example.com/dav/calendars/me/event1.ics"));
    }

    #[test]
    fn resolve_href_accepts_full_url_same_origin() {
        let resolved = resolve_href(
            "https://cal.example.com/dav/calendars/me/event1.ics",
            "https://cal.example.com/dav/calendars/me",
        );
        assert_eq!(resolved.as_deref(), Some("https://cal.example.com/dav/calendars/me/event1.ics"));
    }

    #[test]
    fn resolve_href_rejects_full_url_different_host() {
        let resolved = resolve_href(
            "https://attacker.example/steal-creds",
            "https://cal.example.com/dav/calendars/me",
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn resolve_href_rejects_scheme_downgrade() {
        // Same host, but http:// instead of https:// would send Basic-Auth
        // credentials in cleartext -- must be rejected same as a host mismatch.
        let resolved = resolve_href(
            "http://cal.example.com/dav/calendars/me/event1.ics",
            "https://cal.example.com/dav/calendars/me",
        );
        assert_eq!(resolved, None);
    }
}
