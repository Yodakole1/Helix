use chrono::Utc;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

use crate::cache;
use crate::credentials;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CardDavSource {
    pub id: i64,
    pub account_id: String,
    pub url: String,
    pub display_name: Option<String>,
    pub username: String,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub contacts_added: u32,
    pub contacts_updated: u32,
}

#[derive(Debug, Serialize)]
pub struct CardDavDiscoveredBook {
    pub url: String,
    pub display_name: Option<String>,
}

// ── vCard parsing (RFC 6350) ──────────────────────────────────────────────────

/// Removes RFC 6350 §3.2 line folds: CRLF (or LF) followed by a single
/// whitespace character is a fold continuation — collapse it.
fn unfold_vcard(input: &str) -> String {
    input
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "")
}

/// Returns `(email, display_name)` pairs from one vCard text. A vCard with
/// multiple `EMAIL` lines produces one pair per address, all sharing the
/// same `FN` as display_name. Missing FN yields `None`; empty EMAIL lines
/// are skipped. Parameter sub-types like `EMAIL;TYPE=WORK:` are handled by
/// stripping everything before the first `:`.
pub(crate) fn parse_vcard(text: &str) -> Vec<(String, Option<String>)> {
    let unfolded = unfold_vcard(text);
    let mut display_name: Option<String> = None;
    let mut emails: Vec<String> = Vec::new();

    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');
        let Some((key_part, value)) = line.split_once(':') else { continue };
        let key = key_part.split(';').next().unwrap_or("").trim().to_uppercase();
        let value = value.trim();
        match key.as_str() {
            "FN" if !value.is_empty() => display_name = Some(value.to_string()),
            "EMAIL" if !value.is_empty() => emails.push(value.to_lowercase()),
            _ => {}
        }
    }

    emails
        .into_iter()
        .map(|email| (email, display_name.clone()))
        .collect()
}

// ── PROPFIND XML parsing ──────────────────────────────────────────────────────

/// Extracts `<D:href>` values from a WebDAV 207 Multi-Status response.
/// Filters out the collection URL itself and any entry whose URL doesn't
/// look like a vCard resource (no `.vcf` suffix and no `text/vcard` content
/// type in the propstat). For simplicity, we collect all hrefs and let the
/// caller skip any that fail to GET as a vCard.
pub(crate) fn parse_propfind_hrefs(xml: &str) -> Vec<String> {
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
                if let Ok(text) = e.unescape() {
                    let s = text.into_owned();
                    if !s.is_empty() {
                        hrefs.push(s);
                    }
                }
                inside_href = false;
            }
            Ok(Event::End(_)) if inside_href => {
                inside_href = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    hrefs
}

// ── HTTP client helpers ───────────────────────────────────────────────────────

fn make_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Helix/1.0")
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

/// Perform a PROPFIND at `url` with `Depth: 1`. Returns the response body as
/// a string.
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
            reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method name"),
            url,
        )
        .basic_auth(username, Some(password))
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=\"utf-8\"")
        .body(body.to_string())
        .send()
        .map_err(|e| {
            let msg = format!("PROPFIND {url} failed: {e}");
            crate::debug_log::record("carddav", &msg);
            msg
        })?;

    let status = resp.status();
    crate::debug_log::record("carddav", format!("PROPFIND {url} -> HTTP {status}"));
    if !status.is_success() && status.as_u16() != 207 {
        return Err(format!("PROPFIND {url} returned HTTP {status}"));
    }
    resp.text().map_err(|e| format!("could not read PROPFIND response: {e}"))
}

const PROPFIND_LIST: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>"#;

const PROPFIND_HOME: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <C:addressbook-home-set/>
  </D:prop>
</D:propfind>"#;

const PROPFIND_BOOKS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
  </D:prop>
</D:propfind>"#;

fn origin_of(url: &str) -> String {
    url.split_once("://")
        .and_then(|(scheme, rest)| rest.split_once('/').map(|(host, _)| format!("{scheme}://{host}")))
        .unwrap_or_else(|| url.to_string())
}

// Resolves a PROPFIND-reported resource href against the collection URL the
// user actually configured. An absolute href is only accepted when it shares
// the collection's origin (scheme + host + port) -- otherwise a compromised
// or malicious server could point a resource at an arbitrary third-party
// host, and since every resource fetch reattaches this account's Basic-Auth
// credentials, resolving it blindly would leak the password to that host on
// every background sync. Returns `None` for an out-of-origin href so the
// caller can skip that resource.
fn resolve_href(href: &str, collection_url: &str) -> Option<String> {
    if href.starts_with("http://") || href.starts_with("https://") {
        if origin_of(href).eq_ignore_ascii_case(&origin_of(collection_url)) {
            Some(href.to_string())
        } else {
            None
        }
    } else if href.starts_with('/') {
        Some(format!("{}{href}", origin_of(collection_url)))
    } else {
        Some(format!("{}/{href}", collection_url.trim_end_matches('/')))
    }
}

// ── Core sync logic ───────────────────────────────────────────────────────────

/// PROPFIND the collection URL, GET each `.vcf` resource, parse vCards, upsert
/// contacts. Returns counts of new vs updated contacts.
fn do_sync(
    client: &reqwest::blocking::Client,
    collection_url: &str,
    username: &str,
    password: &str,
    // Origin tag written to contacts.source ("carddav:<id>") so the
    // address-book view can list one synced book at a time.
    source_tag: &str,
) -> Result<SyncResult, String> {
    let propfind_body = propfind(client, collection_url, username, password, PROPFIND_LIST, "1")?;
    let all_hrefs = parse_propfind_hrefs(&propfind_body);

    // The first href is the collection itself — skip it and anything that
    // doesn't look like a vCard.
    let vcard_hrefs: Vec<&str> = all_hrefs
        .iter()
        .map(|h| h.as_str())
        .filter(|h| {
            let lower = h.to_lowercase();
            lower.ends_with(".vcf") || lower.ends_with(".vcard")
        })
        .collect();

    let conn = cache::open()?;
    let mut added = 0u32;
    let mut updated = 0u32;

    for href in vcard_hrefs {
        let Some(resource_url) = resolve_href(href, collection_url) else {
            log::warn!("CardDAV resource href {href} is outside {collection_url}'s origin; skipping");
            continue;
        };

        let resp = match client
            .get(&resource_url)
            .basic_auth(username, Some(password))
            .send()
        {
            Ok(r) if r.status().is_success() => {
                crate::debug_log::record("carddav", format!("GET {resource_url} -> HTTP {}", r.status()));
                r
            }
            Ok(r) => {
                let msg = format!("CardDAV GET {resource_url} returned {}", r.status());
                log::warn!("{msg}");
                crate::debug_log::record("carddav", &msg);
                continue;
            }
            Err(e) => {
                let msg = format!("CardDAV GET {resource_url} failed: {e}");
                log::warn!("{msg}");
                crate::debug_log::record("carddav", &msg);
                continue;
            }
        };

        let vcard_text = match resp.text() {
            Ok(t) => t,
            Err(e) => {
                log::warn!("could not read vCard at {resource_url}: {e}");
                continue;
            }
        };

        for (email, display_name) in parse_vcard(&vcard_text) {
            if email.is_empty() {
                continue;
            }
            let exists: i64 = conn
                .query_row(
                    "SELECT count(*) FROM contacts WHERE email = ?1",
                    rusqlite::params![email],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            if let Err(e) =
                cache::upsert_contacts_from(&conn, &[(email.clone(), display_name)], source_tag)
            {
                log::warn!("could not upsert contact {email}: {e}");
                continue;
            }

            if exists == 0 { added += 1 } else { updated += 1 }
        }
    }

    Ok(SyncResult { contacts_added: added, contacts_updated: updated })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Adds a CardDAV addressbook source, stores the password in the OS keychain,
/// and runs an immediate first sync. Rolls back the keychain entry if the DB
/// insert fails; rolls back both if the first sync fails (same pattern as
/// `add_account` in account.rs — never leave a dangling credential).
#[tauri::command]
pub async fn add_carddav_source(
    account_id: String,
    url: String,
    username: String,
    password: String,
    display_name: Option<String>,
) -> Result<CardDavSource, String> {
    crate::run_blocking(move || {
        add_carddav_source_blocking(account_id, url, username, password, display_name)
    })
    .await
}

pub(crate) fn add_carddav_source_blocking(
    account_id: String,
    url: String,
    username: String,
    mut password: String,
    display_name: Option<String>,
) -> Result<CardDavSource, String> {
    let client = make_client()?;

    // Validate by attempting a PROPFIND before persisting anything.
    propfind(&client, &url, &username, &password, PROPFIND_LIST, "0")
        .map_err(|e| format!("could not reach CardDAV server at {url}: {e}"))?;

    let conn = cache::open()?;
    let id = cache::insert_carddav_source(&conn, &account_id, &url, display_name.as_deref(), &username)?;

    // Store password in keychain under "carddav__{id}".
    let key = format!("carddav__{id}");
    credentials::store_credential(key.clone(), password.clone()).map_err(|e| {
        let _ = cache::delete_carddav_source_db(&conn, id);
        e
    })?;

    // Initial sync — roll back both DB row and keychain on failure.
    let result = do_sync(&client, &url, &username, &password, &format!("carddav:{id}"));
    use zeroize::Zeroize;
    password.zeroize();

    match result {
        Ok(_) => {
            let ts = Utc::now().to_rfc3339();
            cache::update_carddav_synced(&conn, id, &ts).ok();
            let record = cache::get_carddav_source(&conn, id)?
                .ok_or_else(|| format!("could not reload CardDAV source {id} after insert"))?;
            Ok(CardDavSource {
                id: record.id,
                account_id: record.account_id,
                url: record.url,
                display_name: record.display_name,
                username: record.username,
                last_synced_at: record.last_synced_at,
            })
        }
        Err(e) => {
            let _ = credentials::delete_credential(key);
            let _ = cache::delete_carddav_source_db(&conn, id);
            Err(format!("initial CardDAV sync failed: {e}"))
        }
    }
}

#[tauri::command]
pub async fn list_carddav_sources() -> Result<Vec<CardDavSource>, String> {
    let conn = cache::open()?;
    Ok(cache::list_carddav_sources_db(&conn)?
        .into_iter()
        .map(|r| CardDavSource {
            id: r.id,
            account_id: r.account_id,
            url: r.url,
            display_name: r.display_name,
            username: r.username,
            last_synced_at: r.last_synced_at,
        })
        .collect())
}

/// Deletes the keychain credential and the DB row. Does NOT delete any
/// contacts that were synced from this source — there is no origin tracking,
/// so contacts are shared with the rest of the address book.
#[tauri::command]
pub async fn delete_carddav_source(id: i64) -> Result<(), String> {
    let key = format!("carddav__{id}");
    // Best-effort keychain deletion (may already be gone).
    credentials::delete_credential(key).ok();
    let conn = cache::open()?;
    cache::delete_carddav_source_db(&conn, id)
}

/// Resolves the password for a stored CardDAV source, healing a missing
/// `carddav__{id}` keychain entry from the owning account's mail credential
/// — same fallback as `caldav::resolve_source_password`, same reasoning:
/// sources connected during onboarding authenticate with the mail password,
/// and only a genuinely absent entry falls back, never a keychain error.
fn resolve_source_password(record: &cache::CardDavSourceRecord) -> Result<String, String> {
    let key = format!("carddav__{}", record.id);
    if let Some(password) = credentials::get_credential_if_exists(&key)? {
        return Ok(password);
    }
    let fallback = credentials::get_credential_if_exists(&record.account_id)?.ok_or_else(|| {
        format!(
            "no stored password for address book {} and no mail credential for {} to fall back to; remove and re-add the address book",
            record.id, record.account_id
        )
    })?;
    // Same OAuth guard as caldav::resolve_source_password: a refresh-token
    // blob must never be sent anywhere as a Basic-auth password.
    if crate::oauth::parse_stored(&fallback).is_some() {
        return Err(format!(
            "the password for address book {} is gone and {} signs in with OAuth, so its mail credential can't stand in; remove and re-add the address book with its own password",
            record.id, record.account_id
        ));
    }
    if let Err(e) = credentials::store_credential(key, fallback.clone()) {
        eprintln!("could not re-store healed CardDAV credential: {e}");
    }
    Ok(fallback)
}

/// Re-fetches all vCards from the source and upserts them into the contacts
/// table. Updates `last_synced_at` on success.
#[tauri::command]
pub async fn sync_carddav(id: i64) -> Result<SyncResult, String> {
    crate::run_blocking(move || sync_carddav_blocking(id)).await
}

pub(crate) fn sync_carddav_blocking(id: i64) -> Result<SyncResult, String> {
    let conn = cache::open()?;
    let record = cache::get_carddav_source(&conn, id)?
        .ok_or_else(|| format!("no CardDAV source with id {id}"))?;

    let password = resolve_source_password(&record)?;

    let client = make_client()?;
    let result = do_sync(&client, &record.url, &record.username, &password, &format!("carddav:{id}"))?;

    let ts = Utc::now().to_rfc3339();
    cache::update_carddav_synced(&conn, id, &ts)?;

    Ok(result)
}

/// RFC 6764 discovery: tries `/.well-known/carddav`, follows the redirect to
/// the principal URL, PROPFINDs for `addressbook-home-set`, then lists the
/// addressbooks found there. Returns the list without persisting anything —
/// the caller picks one and calls `add_carddav_source` with its URL.
///
/// `host` may be a full base URL or just a hostname.
#[tauri::command]
pub async fn discover_carddav(
    host: String,
    username: String,
    password: String,
) -> Result<Vec<CardDavDiscoveredBook>, String> {
    crate::run_blocking(move || discover_carddav_blocking(host, username, password)).await
}

pub(crate) fn discover_carddav_blocking(
    host: String,
    username: String,
    password: String,
) -> Result<Vec<CardDavDiscoveredBook>, String> {
    let client = make_client()?;

    // Normalise host to a base URL.
    let base = if host.starts_with("http://") || host.starts_with("https://") {
        host.trim_end_matches('/').to_string()
    } else {
        format!("https://{}", host.trim_end_matches('/'))
    };

    // Step 1: GET /.well-known/carddav — most servers redirect to the
    // principal URL. Follow redirects automatically (reqwest default).
    let well_known_url = format!("{base}/.well-known/carddav");
    let principal_url = client
        .get(&well_known_url)
        .basic_auth(&username, Some(&password))
        .send()
        .map(|r| r.url().to_string())
        .unwrap_or_else(|_| well_known_url.clone());

    // Step 2: PROPFIND on principal URL to find addressbook-home-set.
    let home_xml =
        propfind(&client, &principal_url, &username, &password, PROPFIND_HOME, "0")
            .unwrap_or_default();
    let home_hrefs = parse_propfind_hrefs(&home_xml);

    // Step 3: PROPFIND on each addressbook home to list collections.
    let mut books = Vec::new();
    let homes: Vec<String> = if home_hrefs.is_empty() {
        // Fall back to treating the principal URL as the home.
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

    for home_url in &homes {
        let Ok(books_xml) = propfind(&client, home_url, &username, &password, PROPFIND_BOOKS, "1") else {
            continue;
        };

        // Pull every href from the response; each non-home-collection href is
        // a candidate addressbook. Display name extraction requires parsing
        // the `<D:displayname>` element — do a simple scan here rather than
        // building a full DOM.
        let hrefs = parse_propfind_hrefs(&books_xml);
        let display_names = parse_displaynames(&books_xml);

        for (i, href) in hrefs.iter().enumerate() {
            if href == home_url || href.trim_end_matches('/') == home_url.trim_end_matches('/') {
                continue; // skip the home collection itself
            }
            let full_url = if href.starts_with("http://") || href.starts_with("https://") {
                href.clone()
            } else {
                format!("{base}{href}")
            };
            books.push(CardDavDiscoveredBook {
                url: full_url,
                display_name: display_names.get(i).cloned(),
            });
        }
    }

    Ok(books)
}

/// Simple extraction of all `<D:displayname>` text values in document order.
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
            Ok(Event::End(_)) if inside => {
                inside = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    names
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_vcard_single_email() {
        let vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice Example\r\nEMAIL:alice@example.com\r\nEND:VCARD\r\n";
        let pairs = parse_vcard(vcard);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, "alice@example.com");
        assert_eq!(pairs[0].1.as_deref(), Some("Alice Example"));
    }

    #[test]
    fn parse_vcard_multiple_emails() {
        let vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bob\r\nEMAIL;TYPE=WORK:bob@work.com\r\nEMAIL;TYPE=HOME:bob@home.com\r\nEND:VCARD\r\n";
        let pairs = parse_vcard(vcard);
        assert_eq!(pairs.len(), 2);
        assert!(pairs.iter().any(|(e, _)| e == "bob@work.com"));
        assert!(pairs.iter().any(|(e, _)| e == "bob@home.com"));
        assert!(pairs.iter().all(|(_, n)| n.as_deref() == Some("Bob")));
    }

    #[test]
    fn parse_vcard_missing_fn_yields_none_display_name() {
        let vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:noname@example.com\r\nEND:VCARD\r\n";
        let pairs = parse_vcard(vcard);
        assert_eq!(pairs.len(), 1);
        assert!(pairs[0].1.is_none());
    }

    #[test]
    fn parse_vcard_folded_lines() {
        // RFC 6350 §3.2 line folding: CRLF + single whitespace = continuation.
        let vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Carol Very\r\n Long Name\r\nEMAIL:carol@example.com\r\nEND:VCARD\r\n";
        let pairs = parse_vcard(vcard);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1.as_deref(), Some("Carol VeryLong Name"));
    }

    #[test]
    fn parse_vcard_lf_line_endings() {
        // Some servers send LF-only, not CRLF.
        let vcard = "BEGIN:VCARD\nVERSION:3.0\nFN:Dave\nEMAIL:dave@example.com\nEND:VCARD\n";
        let pairs = parse_vcard(vcard);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, "dave@example.com");
    }

    #[test]
    fn parse_propfind_hrefs_extracts_href_elements() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cards/</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/cards/alice.vcf</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/cards/bob.vcf</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;

        let hrefs = parse_propfind_hrefs(xml);
        assert_eq!(hrefs.len(), 3);
        assert!(hrefs.contains(&"/cards/alice.vcf".to_string()));
        assert!(hrefs.contains(&"/cards/bob.vcf".to_string()));
    }

    #[test]
    fn unfold_vcard_removes_crlf_fold() {
        // RFC 6350: the fold point goes AFTER any content whitespace; the one
        // space after CRLF is the fold indicator (not content) and is stripped.
        let folded = "DESCRIPTION:This is a long \r\n description \r\n that is folded.";
        let unfolded = unfold_vcard(folded);
        assert_eq!(unfolded, "DESCRIPTION:This is a long description that is folded.");
    }

    // Integration test: requires a live CardDAV server (Baïkal or Radicale).
    #[tokio::test]
    #[ignore = "requires a local CardDAV server — see docs/technical/carddav.md"]
    async fn syncs_contacts_from_a_live_carddav_server() {
        // In a real run: stand up Baïkal or Radicale, seed a vCard or two,
        // then exercise add_carddav_source / sync_carddav against it.
        // This test is a placeholder for that flow.
    }

    #[test]
    fn resolve_href_accepts_relative_paths() {
        let resolved = resolve_href("alice.vcf", "https://cards.example.com/dav/addressbooks/me");
        assert_eq!(resolved.as_deref(), Some("https://cards.example.com/dav/addressbooks/me/alice.vcf"));
    }

    #[test]
    fn resolve_href_accepts_absolute_path_same_origin() {
        let resolved = resolve_href("/dav/addressbooks/me/alice.vcf", "https://cards.example.com/dav/addressbooks/me");
        assert_eq!(resolved.as_deref(), Some("https://cards.example.com/dav/addressbooks/me/alice.vcf"));
    }

    #[test]
    fn resolve_href_accepts_full_url_same_origin() {
        let resolved = resolve_href(
            "https://cards.example.com/dav/addressbooks/me/alice.vcf",
            "https://cards.example.com/dav/addressbooks/me",
        );
        assert_eq!(resolved.as_deref(), Some("https://cards.example.com/dav/addressbooks/me/alice.vcf"));
    }

    #[test]
    fn resolve_href_rejects_full_url_different_host() {
        let resolved = resolve_href(
            "https://attacker.example/steal-creds",
            "https://cards.example.com/dav/addressbooks/me",
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn resolve_href_rejects_scheme_downgrade() {
        let resolved = resolve_href(
            "http://cards.example.com/dav/addressbooks/me/alice.vcf",
            "https://cards.example.com/dav/addressbooks/me",
        );
        assert_eq!(resolved, None);
    }
}
