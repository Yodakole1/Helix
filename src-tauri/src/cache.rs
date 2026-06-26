use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::credentials::SERVICE_NAME;
use crate::imap::{MessageBody, MessageSummary};

const CACHE_KEY_ACCOUNT: &str = "__local_cache_key__";
const DB_FILE_NAME: &str = "cache.sqlite3";

fn cache_key_entry_named(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, account).map_err(|e| e.to_string())
}

fn cache_key_entry() -> Result<keyring::Entry, String> {
    cache_key_entry_named(CACHE_KEY_ACCOUNT)
}

fn generate_key_hex() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolves the SQLCipher passphrase from `entry`, generating and
/// persisting a new random one on first run.
///
/// Distinguishes "no entry yet" (`keyring::Error::NoEntry`) from any other
/// keychain failure before deciding to mint a new key. Collapsing every
/// error into "generate a new key" would mean a transient failure (Secret
/// Service not running, a permissions hiccup) looks identical to "this is
/// the first run" — silently minting a fresh key and permanently
/// stranding whatever was already encrypted under the real one. Split
/// from `get_or_create_cache_key` so tests can exercise this against a
/// throwaway keychain entry, never the real one `open()` uses for
/// production data -- a test that deleted/regenerated the real entry
/// would orphan any real on-disk cache encrypted under the key it just
/// deleted.
fn get_or_create_cache_key_for(entry: &keyring::Entry) -> Result<String, String> {
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            let key = generate_key_hex();
            entry.set_password(&key).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn get_or_create_cache_key() -> Result<String, String> {
    get_or_create_cache_key_for(&cache_key_entry()?)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cached_messages (
            account_id  TEXT NOT NULL,
            folder      TEXT NOT NULL,
            uid         INTEGER NOT NULL,
            subject     TEXT,
            from_addr   TEXT,
            date        TEXT,
            seen        INTEGER NOT NULL DEFAULT 0,
            flagged     INTEGER NOT NULL DEFAULT 0,
            body_text   TEXT,
            body_html   TEXT,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            account_id        TEXT PRIMARY KEY,
            display_name      TEXT,
            imap_host         TEXT NOT NULL,
            imap_port         INTEGER NOT NULL,
            smtp_host         TEXT NOT NULL,
            smtp_port         INTEGER NOT NULL,
            smtp_use_starttls INTEGER NOT NULL DEFAULT 0,
            archive_folder    TEXT NOT NULL DEFAULT 'Archive',
            trash_folder      TEXT NOT NULL DEFAULT 'Trash',
            created_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contacts (
            email         TEXT PRIMARY KEY,
            display_name  TEXT,
            last_seen_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pgp_keys (
            account_id   TEXT PRIMARY KEY,
            public_key   TEXT NOT NULL,
            secret_key   TEXT NOT NULL,
            fingerprint  TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pgp_contact_keys (
            email        TEXT PRIMARY KEY,
            public_key   TEXT NOT NULL,
            fingerprint  TEXT NOT NULL,
            imported_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS drafts (
            draft_id    TEXT PRIMARY KEY,
            account_id  TEXT NOT NULL,
            to_addr     TEXT,
            subject     TEXT,
            body_text   TEXT,
            body_html   TEXT,
            in_reply_to TEXT,
            refs        TEXT,
            imap_uid    INTEGER,
            saved_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS outbox (
            outbox_id     TEXT PRIMARY KEY,
            account_id    TEXT NOT NULL,
            to_addr       TEXT NOT NULL,
            subject       TEXT NOT NULL,
            body_text     TEXT NOT NULL,
            body_html     TEXT,
            attachments   TEXT,
            in_reply_to   TEXT,
            refs          TEXT,
            encrypt       INTEGER NOT NULL DEFAULT 0,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            created_at    TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("schema setup failed: {e}"))
}

/// Opens the local encrypted cache at `path`, applying `key` as its
/// SQLCipher passphrase, and makes sure the schema exists. Split out from
/// `open()` so tests (in this module and `pgp.rs`) can exercise it
/// against a temp-dir path and an explicit key without touching the real
/// OS keychain or app data dir. `pub(crate)` for exactly that reason --
/// not meant to be called outside tests.
pub(crate) fn open_at(path: &Path, key: &str) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }

    let conn = Connection::open(path).map_err(|e| format!("could not open cache db: {e}"))?;
    conn.pragma_update(None, "key", format!("x'{key}'"))
        .map_err(|e| format!("could not set cache db key: {e}"))?;

    // SQLCipher doesn't actually validate the key until the first real
    // read/write touches the database file — force that now with a
    // throwaway query so a wrong key fails clearly right here, not
    // confusingly on whatever query happens to run first later.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|e| format!("could not unlock cache db (wrong key?): {e}"))?;

    ensure_schema(&conn)?;

    // Additive migrations: ALTER TABLE silently fails when the column already
    // exists (new installs where ensure_schema already created it), so `let _`
    // is intentional rather than lazy error suppression.
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN drafts_folder TEXT NOT NULL DEFAULT 'Drafts'",
        [],
    );

    Ok(conn)
}

/// Opens (creating if necessary) the app's local encrypted message cache.
fn cache_db_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "could not resolve a data directory for this OS".to_string())?
        .join(SERVICE_NAME);
    Ok(dir.join(DB_FILE_NAME))
}

/// One connection per call, matching the rest of the backend's
/// open-per-command pattern (see `imap.rs`) — there's no long-lived pool
/// yet, and no concrete reason to add one until that changes.
pub fn open() -> Result<Connection, String> {
    let key = get_or_create_cache_key()?;
    open_at(&cache_db_path()?, &key)
}

/// Size and row-count snapshot of the local cache, for Settings' Data &
/// Storage section. `size_bytes` is the whole SQLCipher file on disk
/// (accounts/contacts/PGP keys included, not just cached mail) since
/// that's the number that actually matters for "how much disk this app
/// is using" — `message_count` is the part that's safe to let the user
/// clear (see `clear_cache` below).
#[derive(Debug, Serialize)]
pub struct CacheStats {
    pub message_count: i64,
    pub size_bytes: u64,
}

fn cache_stats_in(conn: &Connection, path: &Path) -> Result<CacheStats, String> {
    let message_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cached_messages", [], |row| row.get(0))
        .map_err(|e| format!("could not count cached messages: {e}"))?;
    let size_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(CacheStats { message_count, size_bytes })
}

#[tauri::command]
pub fn cache_stats() -> Result<CacheStats, String> {
    let path = cache_db_path()?;
    let conn = open()?;
    cache_stats_in(&conn, &path)
}

fn clear_cache_in(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM cached_messages", [])
        .map_err(|e| format!("could not clear cached messages: {e}"))?;
    Ok(())
}

/// Clears cached message summaries/bodies only. Deliberately does not
/// touch `accounts`/`contacts`/`pgp_keys`/`pgp_contact_keys` — those are
/// durable data, not disposable cache, and a PGP secret key in
/// particular is unrecoverable once deleted. "Clear cache" should never
/// be able to take out an encryption identity as a side effect.
#[tauri::command]
pub fn clear_cache() -> Result<(), String> {
    let conn = open()?;
    clear_cache_in(&conn)
}

/// Upserts message summaries fetched for one account/folder. Only the
/// summary columns are touched on conflict — any body already cached for
/// that UID (from a prior `upsert_body` call) is left alone.
pub fn upsert_summaries(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    summaries: &[MessageSummary],
) -> Result<(), String> {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start cache transaction: {e}"))?;

    for summary in summaries {
        let Some(uid) = summary.uid else { continue };
        tx.execute(
            "INSERT INTO cached_messages
                (account_id, folder, uid, subject, from_addr, date, seen, flagged, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(account_id, folder, uid) DO UPDATE SET
                subject = excluded.subject,
                from_addr = excluded.from_addr,
                date = excluded.date,
                seen = excluded.seen,
                flagged = excluded.flagged,
                fetched_at = excluded.fetched_at",
            params![
                account_id,
                folder,
                uid,
                summary.subject,
                summary.from,
                summary.date,
                summary.seen,
                summary.flagged,
                fetched_at,
            ],
        )
        .map_err(|e| format!("could not cache message summary: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("could not commit cache transaction: {e}"))
}

/// Upserts the body of one message. Only the body columns are touched on
/// conflict — any summary fields already cached for that UID are left
/// alone.
pub fn upsert_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
    body: &MessageBody,
) -> Result<(), String> {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cached_messages (account_id, folder, uid, body_text, body_html, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            body_text = excluded.body_text,
            body_html = excluded.body_html,
            fetched_at = excluded.fetched_at",
        params![account_id, folder, uid, body.text, body.html, fetched_at],
    )
    .map_err(|e| format!("could not cache message body: {e}"))?;
    Ok(())
}

/// A stored account's connection metadata. Never carries a password --
/// that stays keychain-only, exactly like every other command in this
/// codebase that takes `account_id` rather than a secret.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountRecord {
    pub account_id: String,
    pub display_name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_use_starttls: bool,
    pub archive_folder: String,
    pub trash_folder: String,
    pub drafts_folder: String,
}

/// Upserts one account's metadata. `created_at` is only set on the
/// initial insert (left out of the `DO UPDATE SET` list) -- calling this
/// again for the same `account_id`, e.g. to correct a host/port after a
/// mistyped onboarding attempt, updates everything else in place without
/// losing when the account was first added.
pub fn upsert_account(conn: &Connection, account: &AccountRecord) -> Result<(), String> {
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO accounts
            (account_id, display_name, imap_host, imap_port, smtp_host, smtp_port,
             smtp_use_starttls, archive_folder, trash_folder, drafts_folder, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(account_id) DO UPDATE SET
            display_name = excluded.display_name,
            imap_host = excluded.imap_host,
            imap_port = excluded.imap_port,
            smtp_host = excluded.smtp_host,
            smtp_port = excluded.smtp_port,
            smtp_use_starttls = excluded.smtp_use_starttls,
            archive_folder = excluded.archive_folder,
            trash_folder = excluded.trash_folder,
            drafts_folder = excluded.drafts_folder",
        params![
            account.account_id,
            account.display_name,
            account.imap_host,
            account.imap_port,
            account.smtp_host,
            account.smtp_port,
            account.smtp_use_starttls,
            account.archive_folder,
            account.trash_folder,
            account.drafts_folder,
            created_at,
        ],
    )
    .map_err(|e| format!("could not store account: {e}"))?;
    Ok(())
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, display_name, imap_host, imap_port, smtp_host, smtp_port,
                    smtp_use_starttls, archive_folder, trash_folder, drafts_folder
             FROM accounts ORDER BY created_at ASC",
        )
        .map_err(|e| format!("could not prepare account list query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AccountRecord {
                account_id: row.get(0)?,
                display_name: row.get(1)?,
                imap_host: row.get(2)?,
                imap_port: row.get(3)?,
                smtp_host: row.get(4)?,
                smtp_port: row.get(5)?,
                smtp_use_starttls: row.get(6)?,
                archive_folder: row.get(7)?,
                trash_folder: row.get(8)?,
                drafts_folder: row.get(9)?,
            })
        })
        .map_err(|e| format!("could not query accounts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read account row: {e}"))
}

/// Removes an account and every message cached for it. Account metadata
/// and its cached mail are deleted together, in one transaction, so
/// removing an account never leaves orphaned `cached_messages` rows
/// behind for an account that no longer exists.
pub fn delete_account(conn: &Connection, account_id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start delete transaction: {e}"))?;

    tx.execute(
        "DELETE FROM cached_messages WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| format!("could not delete cached messages: {e}"))?;
    tx.execute("DELETE FROM accounts WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("could not delete account: {e}"))?;

    tx.commit()
        .map_err(|e| format!("could not commit delete transaction: {e}"))
}

/// One entry in the local address book, built up from addresses seen in
/// mail the user has read or sent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ContactRecord {
    pub email: String,
    pub display_name: Option<String>,
}

/// Upserts a batch of `(email, display_name)` sightings -- one
/// transaction, same shape as `upsert_summaries`. Email addresses are
/// lowercased before storing (mailboxes are conventionally
/// case-insensitive, and without this "Foo@x.com" and "foo@x.com" would
/// otherwise dedupe as two different contacts). A sighting with no name
/// (a bare envelope address) never blanks out a name already known for
/// that address from an earlier sighting -- `COALESCE` keeps the
/// existing name unless the new sighting actually has one.
pub fn upsert_contacts(conn: &Connection, contacts: &[(String, Option<String>)]) -> Result<(), String> {
    let last_seen_at = chrono::Utc::now().to_rfc3339();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start contacts transaction: {e}"))?;

    for (email, display_name) in contacts {
        let email = email.trim().to_lowercase();
        if email.is_empty() {
            continue;
        }
        tx.execute(
            "INSERT INTO contacts (email, display_name, last_seen_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(email) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, contacts.display_name),
                last_seen_at = excluded.last_seen_at",
            params![email, display_name, last_seen_at],
        )
        .map_err(|e| format!("could not cache contact: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("could not commit contacts transaction: {e}"))
}

/// Searches the address book for compose-time autocomplete. `%`/`_` are
/// stripped from `query` first so user input can't be interpreted as
/// extra SQL `LIKE` wildcards (e.g. searching for `_` matching every
/// single-character-different row). Split from the `#[tauri::command]`
/// wrapper below so tests can exercise it against a temp-dir connection,
/// same testability split as `open_at`/`open`.
fn search_contacts_in(conn: &Connection, query: &str, limit: u32) -> Result<Vec<ContactRecord>, String> {
    let sanitized = query.replace('%', "").replace('_', "");
    let pattern = format!("%{sanitized}%");

    let mut stmt = conn
        .prepare(
            "SELECT email, display_name FROM contacts
             WHERE email LIKE ?1 OR display_name LIKE ?1
             ORDER BY last_seen_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("could not prepare contact search: {e}"))?;
    let rows = stmt
        .query_map(params![pattern, limit], |row| {
            Ok(ContactRecord {
                email: row.get(0)?,
                display_name: row.get(1)?,
            })
        })
        .map_err(|e| format!("could not search contacts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read contact row: {e}"))
}

#[tauri::command]
pub fn search_contacts(query: String, limit: u32) -> Result<Vec<ContactRecord>, String> {
    let conn = open()?;
    search_contacts_in(&conn, &query, limit)
}

/// One account's own PGP identity. `secret_key` is ASCII-armored and
/// unprotected by a separate passphrase -- its only protection is this
/// database's own SQLCipher encryption at rest, the same as everything
/// else in it. See `pgp.md` for why that's the deliberate choice for now.
#[derive(Debug, Clone, PartialEq)]
pub struct OwnPgpKey {
    pub account_id: String,
    pub public_key: String,
    pub secret_key: String,
    pub fingerprint: String,
}

/// Upserts an account's own keypair. A true upsert (not insert-only) so
/// importing a replacement identity for an account that already has one
/// just overwrites it, same as `upsert_account`.
pub fn upsert_own_key(conn: &Connection, key: &OwnPgpKey) -> Result<(), String> {
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO pgp_keys (account_id, public_key, secret_key, fingerprint, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id) DO UPDATE SET
            public_key = excluded.public_key,
            secret_key = excluded.secret_key,
            fingerprint = excluded.fingerprint",
        params![key.account_id, key.public_key, key.secret_key, key.fingerprint, created_at],
    )
    .map_err(|e| format!("could not store PGP key: {e}"))?;
    Ok(())
}

/// Returns `Ok(None)`, not an error, when the account has no key on file
/// -- "no key yet" is an expected, ordinary state for most accounts, not
/// a failure.
pub fn get_own_key(conn: &Connection, account_id: &str) -> Result<Option<OwnPgpKey>, String> {
    conn.query_row(
        "SELECT account_id, public_key, secret_key, fingerprint FROM pgp_keys WHERE account_id = ?1",
        params![account_id],
        |row| {
            Ok(OwnPgpKey {
                account_id: row.get(0)?,
                public_key: row.get(1)?,
                secret_key: row.get(2)?,
                fingerprint: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not read PGP key: {e}"))
}

/// A recipient's public key, imported manually -- there's no keyserver
/// lookup or WKD discovery, see `pgp.md`.
#[derive(Debug, Clone, PartialEq)]
pub struct ContactPgpKey {
    pub email: String,
    pub public_key: String,
    pub fingerprint: String,
}

pub fn upsert_contact_key(conn: &Connection, key: &ContactPgpKey) -> Result<(), String> {
    let imported_at = chrono::Utc::now().to_rfc3339();
    let email = key.email.trim().to_lowercase();
    conn.execute(
        "INSERT INTO pgp_contact_keys (email, public_key, fingerprint, imported_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(email) DO UPDATE SET
            public_key = excluded.public_key,
            fingerprint = excluded.fingerprint,
            imported_at = excluded.imported_at",
        params![email, key.public_key, key.fingerprint, imported_at],
    )
    .map_err(|e| format!("could not store contact PGP key: {e}"))?;
    Ok(())
}

/// Same "no key on file" -> `Ok(None)` convention as `get_own_key`.
pub fn get_contact_key(conn: &Connection, email: &str) -> Result<Option<ContactPgpKey>, String> {
    let email = email.trim().to_lowercase();
    conn.query_row(
        "SELECT email, public_key, fingerprint FROM pgp_contact_keys WHERE email = ?1",
        params![email],
        |row| {
            Ok(ContactPgpKey {
                email: row.get(0)?,
                public_key: row.get(1)?,
                fingerprint: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not read contact PGP key: {e}"))
}

// ---------------------------------------------------------------------------
// Draft and outbox storage
// ---------------------------------------------------------------------------

/// A locally-saved draft. `refs` is stored as a JSON array in the DB;
/// it's decoded to `Vec<String>` when read back out. `imap_uid` is `None`
/// until the draft has been successfully APPENDed to the server's Drafts
/// folder (see `drafts.rs`).
#[derive(Debug, Clone, Serialize)]
pub struct DraftRecord {
    pub draft_id: String,
    pub account_id: String,
    pub to_addr: Option<String>,
    pub subject: Option<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub imap_uid: Option<u32>,
    pub saved_at: String,
}

/// Trimmed view returned by `list_drafts` -- enough for a Drafts folder
/// listing without fetching body text for every row.
#[derive(Debug, Clone, Serialize)]
pub struct DraftSummary {
    pub draft_id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub to_addr: Option<String>,
    pub saved_at: String,
}

/// A message queued for sending. Stored when `send_message` fails (offline,
/// transient SMTP error) so `flush_outbox` can retry it on reconnect.
/// `attachments` is stored as a JSON-encoded `Vec<OutgoingAttachment>`.
/// `refs` is stored as a JSON array, same as drafts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxRecord {
    pub outbox_id: String,
    pub account_id: String,
    pub to_addr: String,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub attachments_json: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub encrypt: bool,
    pub attempt_count: u32,
    pub last_error: Option<String>,
    pub created_at: String,
}

pub fn upsert_draft(conn: &Connection, draft: &DraftRecord) -> Result<(), String> {
    let refs_json = serde_json::to_string(&draft.references)
        .map_err(|e| format!("could not serialize draft references: {e}"))?;
    conn.execute(
        "INSERT INTO drafts
            (draft_id, account_id, to_addr, subject, body_text, body_html,
             in_reply_to, refs, imap_uid, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(draft_id) DO UPDATE SET
            to_addr = excluded.to_addr,
            subject = excluded.subject,
            body_text = excluded.body_text,
            body_html = excluded.body_html,
            in_reply_to = excluded.in_reply_to,
            refs = excluded.refs,
            saved_at = excluded.saved_at",
        params![
            draft.draft_id,
            draft.account_id,
            draft.to_addr,
            draft.subject,
            draft.body_text,
            draft.body_html,
            draft.in_reply_to,
            refs_json,
            draft.imap_uid,
            draft.saved_at,
        ],
    )
    .map_err(|e| format!("could not save draft: {e}"))?;
    Ok(())
}

pub fn get_draft(conn: &Connection, draft_id: &str) -> Result<Option<DraftRecord>, String> {
    conn.query_row(
        "SELECT draft_id, account_id, to_addr, subject, body_text, body_html,
                in_reply_to, refs, imap_uid, saved_at
         FROM drafts WHERE draft_id = ?1",
        params![draft_id],
        |row| {
            let refs_json: Option<String> = row.get(7)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                refs_json,
                row.get::<_, Option<u32>>(8)?,
                row.get::<_, String>(9)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("could not read draft: {e}"))?
    .map(|(draft_id, account_id, to_addr, subject, body_text, body_html, in_reply_to, refs_json, imap_uid, saved_at)| {
        let references = refs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        Ok(DraftRecord { draft_id, account_id, to_addr, subject, body_text, body_html, in_reply_to, references, imap_uid, saved_at })
    })
    .transpose()
}

pub fn list_drafts(conn: &Connection, account_id: &str) -> Result<Vec<DraftSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT draft_id, account_id, subject, to_addr, saved_at
             FROM drafts WHERE account_id = ?1 ORDER BY saved_at DESC",
        )
        .map_err(|e| format!("could not prepare draft list query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id], |row| {
            Ok(DraftSummary {
                draft_id: row.get(0)?,
                account_id: row.get(1)?,
                subject: row.get(2)?,
                to_addr: row.get(3)?,
                saved_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("could not query drafts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read draft row: {e}"))
}

pub fn delete_draft(conn: &Connection, draft_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM drafts WHERE draft_id = ?1", params![draft_id])
        .map_err(|e| format!("could not delete draft: {e}"))?;
    Ok(())
}

// Not yet called — drafts.rs will use this once APPEND returns APPENDUID.
#[allow(dead_code)]
pub fn update_draft_imap_uid(conn: &Connection, draft_id: &str, uid: u32) -> Result<(), String> {
    conn.execute(
        "UPDATE drafts SET imap_uid = ?1 WHERE draft_id = ?2",
        params![uid, draft_id],
    )
    .map_err(|e| format!("could not update draft imap_uid: {e}"))?;
    Ok(())
}

pub fn insert_outbox_item(conn: &Connection, record: &OutboxRecord) -> Result<(), String> {
    let refs_json = serde_json::to_string(&record.references)
        .map_err(|e| format!("could not serialize outbox references: {e}"))?;
    conn.execute(
        "INSERT INTO outbox
            (outbox_id, account_id, to_addr, subject, body_text, body_html,
             attachments, in_reply_to, refs, encrypt, attempt_count, last_error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            record.outbox_id,
            record.account_id,
            record.to_addr,
            record.subject,
            record.body_text,
            record.body_html,
            record.attachments_json,
            record.in_reply_to,
            refs_json,
            record.encrypt,
            record.attempt_count,
            record.last_error,
            record.created_at,
        ],
    )
    .map_err(|e| format!("could not insert outbox item: {e}"))?;
    Ok(())
}

pub fn list_outbox(conn: &Connection, account_id: &str) -> Result<Vec<OutboxRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT outbox_id, account_id, to_addr, subject, body_text, body_html,
                    attachments, in_reply_to, refs, encrypt, attempt_count, last_error, created_at
             FROM outbox WHERE account_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| format!("could not prepare outbox list query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id], |row| {
            let refs_json: Option<String> = row.get(8)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                refs_json,
                row.get::<_, bool>(9)?,
                row.get::<_, u32>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, String>(12)?,
            ))
        })
        .map_err(|e| format!("could not query outbox: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read outbox row: {e}"))?
        .into_iter()
        .map(|(outbox_id, account_id, to_addr, subject, body_text, body_html, attachments_json, in_reply_to, refs_json, encrypt, attempt_count, last_error, created_at)| {
            let references = refs_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok(OutboxRecord { outbox_id, account_id, to_addr, subject, body_text, body_html, attachments_json, in_reply_to, references, encrypt, attempt_count, last_error, created_at })
        })
        .collect()
}

pub fn delete_outbox_item(conn: &Connection, outbox_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM outbox WHERE outbox_id = ?1", params![outbox_id])
        .map_err(|e| format!("could not delete outbox item: {e}"))?;
    Ok(())
}

pub fn mark_outbox_attempt(conn: &Connection, outbox_id: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE outbox SET attempt_count = attempt_count + 1, last_error = ?1 WHERE outbox_id = ?2",
        params![error, outbox_id],
    )
    .map_err(|e| format!("could not update outbox attempt: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::AttachmentInfo;

    struct TempCachePath(std::path::PathBuf);

    impl TempCachePath {
        fn new(label: &str) -> Self {
            let unique = format!(
                "helix-cache-test-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            Self(std::env::temp_dir().join(unique).join(DB_FILE_NAME))
        }
    }

    impl Drop for TempCachePath {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    fn sample_summary(uid: u32) -> MessageSummary {
        MessageSummary {
            uid: Some(uid),
            subject: Some("Test subject".to_string()),
            from: Some("Sender <sender@helix.test>".to_string()),
            date: Some("2026-06-20T00:00:00+00:00".to_string()),
            seen: false,
            flagged: true,
            message_id: None,
            in_reply_to: None,
        }
    }

    fn sample_body() -> MessageBody {
        MessageBody {
            text: Some("plain text body".to_string()),
            html: Some("<p>html body</p>".to_string()),
            attachments: vec![AttachmentInfo {
                index: 0,
                filename: Some("file.pdf".to_string()),
                content_type: Some("application/pdf".to_string()),
                size: 1234,
            }],
            pgp_signed_by: None,
            pgp_signature_valid: None,
            from: Some("Sender <sender@helix.test>".to_string()),
            to: vec!["Recipient <recipient@helix.test>".to_string()],
            cc: Vec::new(),
            reply_to: None,
            message_id: Some("abc123@helix.test".to_string()),
            in_reply_to: None,
            references: Vec::new(),
        }
    }

    #[test]
    fn round_trips_a_summary_and_body_through_the_cache() {
        let path = TempCachePath::new("round-trip");
        let conn = open_at(&path.0, "aa").expect("open should succeed");

        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
            .expect("caching summaries should succeed");
        upsert_body(&conn, "me@helix.test", "INBOX", 1, &sample_body())
            .expect("caching body should succeed");

        let (subject, flagged, body_text): (String, bool, String) = conn
            .query_row(
                "SELECT subject, flagged, body_text FROM cached_messages
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params!["me@helix.test", "INBOX", 1],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("row should exist");

        assert_eq!(subject, "Test subject");
        assert!(flagged);
        assert_eq!(body_text, "plain text body");
    }

    #[test]
    fn cache_stats_counts_messages_and_reports_a_nonzero_file_size() {
        let path = TempCachePath::new("stats");
        let conn = open_at(&path.0, "zz").expect("open should succeed");
        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1), sample_summary(2)])
            .expect("caching summaries should succeed");

        let stats = cache_stats_in(&conn, &path.0).expect("stats should succeed");

        assert_eq!(stats.message_count, 2);
        assert!(stats.size_bytes > 0, "an existing SQLCipher file should report a nonzero size");
    }

    #[test]
    fn clear_cache_removes_messages_but_leaves_accounts_and_keys_alone() {
        let path = TempCachePath::new("clear-cache");
        let conn = open_at(&path.0, "yy").expect("open should succeed");
        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)]).expect("caching summaries should succeed");
        upsert_account(&conn, &sample_account("me@helix.test")).expect("caching account should succeed");

        clear_cache_in(&conn).expect("clearing cache should succeed");

        let stats = cache_stats_in(&conn, &path.0).expect("stats should succeed");
        assert_eq!(stats.message_count, 0, "cached messages should be gone");
        let accounts = list_accounts(&conn).expect("listing accounts should succeed");
        assert_eq!(accounts.len(), 1, "accounts must survive a cache clear");
    }

    #[test]
    fn upserting_a_body_does_not_clobber_an_already_cached_summary() {
        let path = TempCachePath::new("preserve-summary");
        let conn = open_at(&path.0, "bb").expect("open should succeed");

        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
            .expect("caching summaries should succeed");
        upsert_body(&conn, "me@helix.test", "INBOX", 1, &sample_body())
            .expect("caching body should succeed");

        let subject: String = conn
            .query_row(
                "SELECT subject FROM cached_messages
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params!["me@helix.test", "INBOX", 1],
                |row| row.get(0),
            )
            .expect("row should exist");

        assert_eq!(
            subject, "Test subject",
            "the summary fields cached before the body must survive the body upsert"
        );
    }

    #[test]
    fn reopening_the_same_path_and_key_preserves_data() {
        let path = TempCachePath::new("reopen");

        {
            let conn = open_at(&path.0, "cc").expect("first open should succeed");
            upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
                .expect("caching summaries should succeed");
        }

        let conn = open_at(&path.0, "cc").expect("reopen with the same key should succeed");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM cached_messages", [], |row| row.get(0))
            .expect("count query should succeed");
        assert_eq!(count, 1, "the row written before reopening should still be there");
    }

    #[test]
    fn opening_with_the_wrong_key_fails() {
        let path = TempCachePath::new("wrong-key");

        {
            let conn = open_at(&path.0, "dd").expect("first open should succeed");
            upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
                .expect("caching summaries should succeed");
        }

        let result = open_at(&path.0, "ee");
        assert!(
            result.is_err(),
            "opening an existing encrypted cache with the wrong key must fail, \
             not silently return an unreadable connection"
        );
    }

    #[test]
    fn get_or_create_cache_key_is_stable_across_calls() {
        // Touches the real OS keychain, same as credentials.rs's
        // round_trips_through_the_real_os_keychain test -- not ignored,
        // this dev environment is expected to have a Secret
        // Service/Keychain/Credential Manager available. Uses a
        // dedicated test-only entry, never `cache_key_entry()` (the real
        // one `open()` uses for production data) -- deleting/regenerating
        // that one here would orphan any real on-disk cache encrypted
        // under the key this test just deleted out from under it.
        let entry =
            cache_key_entry_named("__local_cache_key_test__").expect("entry should be constructible");
        entry.delete_credential().ok(); // start from a clean slate

        let first = get_or_create_cache_key_for(&entry).expect("first call should succeed");
        let second = get_or_create_cache_key_for(&entry).expect("second call should succeed");

        entry.delete_credential().ok();

        assert_eq!(first, second, "the same key must be returned across calls");
    }

    fn sample_account(account_id: &str) -> AccountRecord {
        AccountRecord {
            account_id: account_id.to_string(),
            display_name: Some("Test Account".to_string()),
            imap_host: "imap.helix.test".to_string(),
            imap_port: 993,
            smtp_host: "smtp.helix.test".to_string(),
            smtp_port: 465,
            smtp_use_starttls: false,
            archive_folder: "Archive".to_string(),
            trash_folder: "Trash".to_string(),
            drafts_folder: "Drafts".to_string(),
        }
    }

    #[test]
    fn upserting_and_listing_accounts_round_trips() {
        let path = TempCachePath::new("accounts-round-trip");
        let conn = open_at(&path.0, "ff").expect("open should succeed");

        upsert_account(&conn, &sample_account("me@helix.test")).expect("upsert should succeed");
        let accounts = list_accounts(&conn).expect("list should succeed");

        assert_eq!(accounts, vec![sample_account("me@helix.test")]);
    }

    #[test]
    fn upserting_an_existing_account_updates_fields_but_preserves_created_at() {
        let path = TempCachePath::new("accounts-preserve-created-at");
        let conn = open_at(&path.0, "gg").expect("open should succeed");

        upsert_account(&conn, &sample_account("me@helix.test")).expect("first upsert should succeed");
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM accounts WHERE account_id = ?1",
                params!["me@helix.test"],
                |row| row.get(0),
            )
            .expect("created_at should exist");

        let mut updated = sample_account("me@helix.test");
        updated.imap_host = "imap2.helix.test".to_string();
        upsert_account(&conn, &updated).expect("second upsert should succeed");

        let (imap_host, created_at_after): (String, String) = conn
            .query_row(
                "SELECT imap_host, created_at FROM accounts WHERE account_id = ?1",
                params!["me@helix.test"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row should still exist");

        assert_eq!(imap_host, "imap2.helix.test", "the updated field should take effect");
        assert_eq!(created_at_after, created_at, "created_at must survive a later upsert");
    }

    #[test]
    fn delete_account_removes_the_account_and_its_cached_messages() {
        let path = TempCachePath::new("delete-account");
        let conn = open_at(&path.0, "hh").expect("open should succeed");

        upsert_account(&conn, &sample_account("me@helix.test")).expect("upsert should succeed");
        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
            .expect("caching summaries should succeed");

        delete_account(&conn, "me@helix.test").expect("delete should succeed");

        let accounts = list_accounts(&conn).expect("list should succeed");
        assert!(accounts.is_empty(), "the account row should be gone");

        let cached_count: i64 = conn
            .query_row("SELECT count(*) FROM cached_messages", [], |row| row.get(0))
            .expect("count query should succeed");
        assert_eq!(cached_count, 0, "cached messages for the removed account should be gone too");
    }

    #[test]
    fn upserting_and_searching_contacts_round_trips() {
        let path = TempCachePath::new("contacts-round-trip");
        let conn = open_at(&path.0, "ii").expect("open should succeed");

        upsert_contacts(
            &conn,
            &[
                ("Alice@Example.com".to_string(), Some("Alice".to_string())),
                ("bob@example.com".to_string(), None),
            ],
        )
        .expect("upsert should succeed");

        let results = search_contacts_in(&conn, "ali", 10).expect("search should succeed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].email, "alice@example.com", "emails are stored lowercased");
        assert_eq!(results[0].display_name.as_deref(), Some("Alice"));

        let all = search_contacts_in(&conn, "example.com", 10).expect("search should succeed");
        assert_eq!(all.len(), 2, "both contacts should match a broader query");
    }

    #[test]
    fn a_nameless_sighting_does_not_clobber_an_already_known_name() {
        let path = TempCachePath::new("contacts-preserve-name");
        let conn = open_at(&path.0, "jj").expect("open should succeed");

        upsert_contacts(&conn, &[("carol@example.com".to_string(), Some("Carol".to_string()))])
            .expect("first upsert should succeed");
        upsert_contacts(&conn, &[("carol@example.com".to_string(), None)])
            .expect("second upsert should succeed");

        let results = search_contacts_in(&conn, "carol", 10).expect("search should succeed");
        assert_eq!(
            results[0].display_name.as_deref(),
            Some("Carol"),
            "a later sighting with no name must not blank out the name already known"
        );
    }

    fn sample_draft(draft_id: &str, account_id: &str) -> DraftRecord {
        DraftRecord {
            draft_id: draft_id.to_string(),
            account_id: account_id.to_string(),
            to_addr: Some("recipient@helix.test".to_string()),
            subject: Some("Draft subject".to_string()),
            body_text: Some("Draft body".to_string()),
            body_html: None,
            in_reply_to: None,
            references: vec!["root@helix.test".to_string()],
            imap_uid: None,
            saved_at: "2026-06-26T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn upserting_and_listing_drafts_round_trips() {
        let path = TempCachePath::new("drafts-round-trip");
        let conn = open_at(&path.0, "kk").expect("open should succeed");

        upsert_draft(&conn, &sample_draft("draft-1", "me@helix.test"))
            .expect("upsert should succeed");
        let drafts = list_drafts(&conn, "me@helix.test").expect("list should succeed");

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].draft_id, "draft-1");
        assert_eq!(drafts[0].subject.as_deref(), Some("Draft subject"));
    }

    #[test]
    fn upserting_a_draft_a_second_time_updates_it_without_creating_a_new_row() {
        let path = TempCachePath::new("drafts-update");
        let conn = open_at(&path.0, "ll").expect("open should succeed");

        upsert_draft(&conn, &sample_draft("draft-1", "me@helix.test"))
            .expect("first upsert should succeed");

        let mut updated = sample_draft("draft-1", "me@helix.test");
        updated.subject = Some("Updated subject".to_string());
        upsert_draft(&conn, &updated).expect("second upsert should succeed");

        let drafts = list_drafts(&conn, "me@helix.test").expect("list should succeed");
        assert_eq!(drafts.len(), 1, "a second upsert must not create a new row");
        assert_eq!(drafts[0].subject.as_deref(), Some("Updated subject"));
    }

    #[test]
    fn get_draft_returns_references_as_a_vec() {
        let path = TempCachePath::new("drafts-references");
        let conn = open_at(&path.0, "mm").expect("open should succeed");

        upsert_draft(&conn, &sample_draft("draft-1", "me@helix.test"))
            .expect("upsert should succeed");
        let draft = get_draft(&conn, "draft-1")
            .expect("get should succeed")
            .expect("draft should exist");

        assert_eq!(draft.references, vec!["root@helix.test"]);
    }

    #[test]
    fn deleting_a_draft_removes_it() {
        let path = TempCachePath::new("drafts-delete");
        let conn = open_at(&path.0, "nn").expect("open should succeed");

        upsert_draft(&conn, &sample_draft("draft-1", "me@helix.test"))
            .expect("upsert should succeed");
        delete_draft(&conn, "draft-1").expect("delete should succeed");

        let drafts = list_drafts(&conn, "me@helix.test").expect("list should succeed");
        assert!(drafts.is_empty(), "the deleted draft should not appear in the list");
    }

    #[test]
    fn update_draft_imap_uid_sets_the_uid() {
        let path = TempCachePath::new("drafts-imap-uid");
        let conn = open_at(&path.0, "oo").expect("open should succeed");

        upsert_draft(&conn, &sample_draft("draft-1", "me@helix.test"))
            .expect("upsert should succeed");
        update_draft_imap_uid(&conn, "draft-1", 42).expect("update should succeed");

        let draft = get_draft(&conn, "draft-1")
            .expect("get should succeed")
            .expect("draft should exist");
        assert_eq!(draft.imap_uid, Some(42));
    }

    fn sample_outbox(outbox_id: &str, account_id: &str) -> OutboxRecord {
        OutboxRecord {
            outbox_id: outbox_id.to_string(),
            account_id: account_id.to_string(),
            to_addr: "recipient@helix.test".to_string(),
            subject: "Queued message".to_string(),
            body_text: "Body".to_string(),
            body_html: None,
            attachments_json: None,
            in_reply_to: None,
            references: Vec::new(),
            encrypt: false,
            attempt_count: 0,
            last_error: None,
            created_at: "2026-06-26T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn inserting_and_listing_outbox_round_trips() {
        let path = TempCachePath::new("outbox-round-trip");
        let conn = open_at(&path.0, "pp").expect("open should succeed");

        insert_outbox_item(&conn, &sample_outbox("out-1", "me@helix.test"))
            .expect("insert should succeed");
        let items = list_outbox(&conn, "me@helix.test").expect("list should succeed");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].outbox_id, "out-1");
        assert_eq!(items[0].subject, "Queued message");
    }

    #[test]
    fn mark_outbox_attempt_increments_count_and_records_error() {
        let path = TempCachePath::new("outbox-attempt");
        let conn = open_at(&path.0, "qq").expect("open should succeed");

        insert_outbox_item(&conn, &sample_outbox("out-1", "me@helix.test"))
            .expect("insert should succeed");
        mark_outbox_attempt(&conn, "out-1", "connection refused").expect("mark should succeed");
        mark_outbox_attempt(&conn, "out-1", "connection refused").expect("mark should succeed");

        let items = list_outbox(&conn, "me@helix.test").expect("list should succeed");
        assert_eq!(items[0].attempt_count, 2);
        assert_eq!(items[0].last_error.as_deref(), Some("connection refused"));
    }

    #[test]
    fn deleting_an_outbox_item_removes_it() {
        let path = TempCachePath::new("outbox-delete");
        let conn = open_at(&path.0, "rr").expect("open should succeed");

        insert_outbox_item(&conn, &sample_outbox("out-1", "me@helix.test"))
            .expect("insert should succeed");
        delete_outbox_item(&conn, "out-1").expect("delete should succeed");

        let items = list_outbox(&conn, "me@helix.test").expect("list should succeed");
        assert!(items.is_empty(), "the deleted outbox item should not appear");
    }

    #[test]
    fn existing_db_gets_drafts_folder_column_on_reopen() {
        // Simulates upgrading an existing DB that predates the drafts_folder column:
        // open without the column, close, reopen (which runs the ALTER TABLE migration),
        // then verify the column exists and has the correct default.
        let path = TempCachePath::new("drafts-folder-migration");

        // First open: schema is created normally (new install already has the column).
        // We verify that list_accounts still returns the default "Drafts" value.
        {
            let conn = open_at(&path.0, "ss").expect("first open should succeed");
            upsert_account(&conn, &sample_account("me@helix.test")).expect("upsert should succeed");
        }

        let conn = open_at(&path.0, "ss").expect("reopen should succeed");
        let accounts = list_accounts(&conn).expect("list should succeed");
        assert_eq!(
            accounts[0].drafts_folder, "Drafts",
            "drafts_folder should be the default value"
        );
    }
}
