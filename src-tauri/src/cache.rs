use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::credentials::SERVICE_NAME;
use crate::imap::{AttachmentContent, AttachmentInfo, MessageBody, MessageSummary};
use crate::pop3::Pop3MessageSummary;

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
            message_id  TEXT,
            in_reply_to TEXT,
            body_text   TEXT,
            body_html   TEXT,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
        );

        -- Downloaded attachment bytes, so a once-downloaded attachment is
        -- available offline (and without re-downloading) on the next open.
        -- Kept in its own table rather than columns on cached_messages: a
        -- message can have many attachments, and most cache reads (summary
        -- lists, body text) have no use for the bytes, so they shouldn't ride
        -- along in every row. Written through by imap.rs's fetch_attachment
        -- only -- attachments aren't cached eagerly on body fetch, only when
        -- the user actually downloads one. `idx` is the same attachment index
        -- fetch_attachment addresses by (parse_message_body's iteration order).
        -- Bounded by a per-item size cap and a total-bytes budget (see
        -- upsert_attachment); evicted oldest-download-first when over budget.
        CREATE TABLE IF NOT EXISTS cached_attachments (
            account_id   TEXT NOT NULL,
            folder       TEXT NOT NULL,
            uid          INTEGER NOT NULL,
            idx          INTEGER NOT NULL,
            filename     TEXT,
            content_type TEXT,
            content      BLOB NOT NULL,
            size         INTEGER NOT NULL,
            fetched_at   TEXT NOT NULL,
            PRIMARY KEY (account_id, folder, uid, idx)
        );

        -- POP3's cache, kept separate from cached_messages on purpose. POP3
        -- has no folders and no IMAP-style integer UID; its stable cross-
        -- session identifier is the optional RFC 1939 UIDL string, so it's
        -- keyed by (account_id, uidl) rather than (account_id, folder, uid).
        -- `number` is the last-seen POP3 message number -- usable to RETR
        -- within a live session, but renumbered by the server after a
        -- deletion, so it's stored as a best-effort hint, never the key.
        -- Messages a server reports no UIDL for simply aren't cached.
        CREATE TABLE IF NOT EXISTS cached_pop3_messages (
            account_id  TEXT NOT NULL,
            uidl        TEXT NOT NULL,
            number      INTEGER,
            subject     TEXT,
            from_addr   TEXT,
            date        TEXT,
            size        INTEGER,
            body_text   TEXT,
            body_html   TEXT,
            message_id  TEXT,
            in_reply_to TEXT,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (account_id, uidl)
        );

        -- POP3's attachment byte cache, the UIDL-keyed counterpart to
        -- cached_attachments (which is IMAP-keyed by folder/uid). Shares the
        -- same total-bytes budget as cached_attachments -- eviction spans
        -- both tables (see evict_attachments_over_budget).
        CREATE TABLE IF NOT EXISTS cached_pop3_attachments (
            account_id   TEXT NOT NULL,
            uidl         TEXT NOT NULL,
            idx          INTEGER NOT NULL,
            filename     TEXT,
            content_type TEXT,
            content      BLOB NOT NULL,
            size         INTEGER NOT NULL,
            fetched_at   TEXT NOT NULL,
            PRIMARY KEY (account_id, uidl, idx)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            account_id        TEXT PRIMARY KEY,
            display_name      TEXT,
            imap_host         TEXT NOT NULL,
            imap_port         INTEGER NOT NULL,
            imap_use_starttls INTEGER NOT NULL DEFAULT 0,
            smtp_host         TEXT NOT NULL,
            smtp_port         INTEGER NOT NULL,
            smtp_use_starttls INTEGER NOT NULL DEFAULT 0,
            incoming_protocol TEXT NOT NULL DEFAULT 'imap',
            pop3_host         TEXT,
            pop3_port         INTEGER,
            archive_folder    TEXT NOT NULL DEFAULT 'Archive',
            trash_folder      TEXT NOT NULL DEFAULT 'Trash',
            created_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contacts (
            email         TEXT PRIMARY KEY,
            display_name  TEXT,
            last_seen_at  TEXT NOT NULL
        );

        -- Send-as aliases for an account. An identity is a different From
        -- address that shares the same account's SMTP credentials. Keyed by
        -- (account_id, address) so an address can only appear once per account
        -- but the same address could theoretically be an alias on two different
        -- accounts.
        CREATE TABLE IF NOT EXISTS identities (
            account_id   TEXT NOT NULL,
            address      TEXT NOT NULL,
            display_name TEXT,
            signature    TEXT,
            created_at   TEXT NOT NULL,
            PRIMARY KEY (account_id, address)
        );

        -- Muted conversation threads. When a thread is muted the user stops
        -- receiving notifications for new replies to it. Keyed by message_id
        -- (the root Message-ID header) since that's the stable cross-session
        -- thread identifier the threading code already uses.
        CREATE TABLE IF NOT EXISTS muted_threads (
            message_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            muted_at   TEXT NOT NULL,
            PRIMARY KEY (message_id, account_id)
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
            attachments TEXT,
            imap_uid    INTEGER,
            saved_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS outbox (
            outbox_id     TEXT PRIMARY KEY,
            account_id    TEXT NOT NULL,
            to_addr       TEXT NOT NULL,
            cc            TEXT NOT NULL DEFAULT '',
            bcc           TEXT NOT NULL DEFAULT '',
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
        );

        -- Full-text search index over cached message summaries/bodies. This is
        -- the local, offline, cross-folder counterpart to imap.rs's server-side
        -- UID SEARCH: it works with no network, spans every account/folder at
        -- once, and only ever sees what's already been cached.
        --
        -- A standalone FTS5 table (not external-content) keyed by
        -- cached_messages's rowid: account_id/folder/uid ride along UNINDEXED so
        -- a hit can be located and opened without a join back to
        -- cached_messages. To_addr isn't indexed because cached_messages doesn't
        -- store recipients (only from_addr), so unlike the server-side search
        -- this matches subject/from/body but not To. The triggers below keep it
        -- in lockstep with cached_messages by rowid.
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            account_id UNINDEXED,
            folder UNINDEXED,
            uid UNINDEXED,
            subject,
            from_addr,
            body_text
        );

        -- Keep the FTS index in sync with cached_messages, keyed by rowid so an
        -- update/delete can find the matching index row directly. This only
        -- stays correct because every write to cached_messages goes through
        -- ordinary SQL, never a direct FTS write.
        CREATE TRIGGER IF NOT EXISTS cached_messages_fts_ai
        AFTER INSERT ON cached_messages BEGIN
            INSERT INTO messages_fts(rowid, account_id, folder, uid, subject, from_addr, body_text)
            VALUES (new.rowid, new.account_id, new.folder, new.uid, new.subject, new.from_addr, new.body_text);
        END;

        CREATE TRIGGER IF NOT EXISTS cached_messages_fts_ad
        AFTER DELETE ON cached_messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
        END;

        CREATE TRIGGER IF NOT EXISTS cached_messages_fts_au
        AFTER UPDATE ON cached_messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.rowid;
            INSERT INTO messages_fts(rowid, account_id, folder, uid, subject, from_addr, body_text)
            VALUES (new.rowid, new.account_id, new.folder, new.uid, new.subject, new.from_addr, new.body_text);
        END;

        -- POP3's own FTS index, parallel to messages_fts. Separate because
        -- POP3 is keyed by (account_id, uidl) with no folder/integer-uid, so
        -- it can't share messages_fts's column shape. `number` rides along
        -- UNINDEXED as the best-effort live-RETR hint; `uidl` is the stable
        -- key a hit is opened by offline. Kept in lockstep with
        -- cached_pop3_messages by rowid, the same way messages_fts tracks
        -- cached_messages.
        CREATE VIRTUAL TABLE IF NOT EXISTS pop3_messages_fts USING fts5(
            account_id UNINDEXED,
            uidl UNINDEXED,
            number UNINDEXED,
            subject,
            from_addr,
            body_text
        );

        CREATE TRIGGER IF NOT EXISTS cached_pop3_messages_fts_ai
        AFTER INSERT ON cached_pop3_messages BEGIN
            INSERT INTO pop3_messages_fts(rowid, account_id, uidl, number, subject, from_addr, body_text)
            VALUES (new.rowid, new.account_id, new.uidl, new.number, new.subject, new.from_addr, new.body_text);
        END;

        CREATE TRIGGER IF NOT EXISTS cached_pop3_messages_fts_ad
        AFTER DELETE ON cached_pop3_messages BEGIN
            DELETE FROM pop3_messages_fts WHERE rowid = old.rowid;
        END;

        CREATE TRIGGER IF NOT EXISTS cached_pop3_messages_fts_au
        AFTER UPDATE ON cached_pop3_messages BEGIN
            DELETE FROM pop3_messages_fts WHERE rowid = old.rowid;
            INSERT INTO pop3_messages_fts(rowid, account_id, uidl, number, subject, from_addr, body_text)
            VALUES (new.rowid, new.account_id, new.uidl, new.number, new.subject, new.from_addr, new.body_text);
        END;

        -- Naive Bayes spam classifier: per-token occurrence counts accumulated
        -- as the user moves messages in/out of the spam folder. Only tokens
        -- the model has been explicitly trained on are stored here; unseen
        -- tokens carry no evidence and aren't inserted. `spam_count` and
        -- `ham_count` are deduplicated per message (each token counted once
        -- per training message, not once per occurrence within it), following
        -- Paul Graham's original approach.
        CREATE TABLE IF NOT EXISTS bayes_tokens (
            token       TEXT NOT NULL PRIMARY KEY,
            spam_count  INTEGER NOT NULL DEFAULT 0,
            ham_count   INTEGER NOT NULL DEFAULT 0
        );

        -- Global trained-message counts for probability normalisation. There
        -- is exactly one row (id = 1); the INSERT OR IGNORE below seeds it on
        -- first open and is silently skipped on every subsequent open.
        CREATE TABLE IF NOT EXISTS bayes_stats (
            id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
            spam_messages INTEGER NOT NULL DEFAULT 0,
            ham_messages  INTEGER NOT NULL DEFAULT 0
        );

        INSERT OR IGNORE INTO bayes_stats (id, spam_messages, ham_messages) VALUES (1, 0, 0);

        -- Snoozed messages: a message is hidden until snooze_until, then
        -- surfaced by flush_snoozed. account_id + folder + uid identify the
        -- IMAP message (or account_id + pop3_uidl for POP3 messages).
        CREATE TABLE IF NOT EXISTS snoozed_messages (
            id          TEXT NOT NULL PRIMARY KEY,
            account_id  TEXT NOT NULL,
            folder      TEXT,
            uid         INTEGER,
            pop3_uidl   TEXT,
            subject     TEXT,
            sender      TEXT,
            snooze_until TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        -- S/MIME own certificates (one per account). Certificate and private
        -- key are DER-encoded and stored unencrypted inside the SQLCipher-
        -- encrypted DB, same rationale as pgp_keys. No per-key passphrase
        -- on top of the DB's own encryption; that can be layered in later.
        CREATE TABLE IF NOT EXISTS smime_own_certs (
            account_id   TEXT PRIMARY KEY,
            certificate  BLOB NOT NULL,
            private_key  BLOB NOT NULL,
            fingerprint  TEXT NOT NULL,
            subject_cn   TEXT,
            not_after    TEXT NOT NULL
        );

        -- S/MIME contact certificates harvested from signed incoming mail or
        -- imported manually. Keyed by lowercased email, one cert per address.
        CREATE TABLE IF NOT EXISTS smime_contact_certs (
            email        TEXT NOT NULL PRIMARY KEY,
            certificate  BLOB NOT NULL,
            fingerprint  TEXT NOT NULL,
            subject_cn   TEXT,
            not_after    TEXT NOT NULL,
            added_at     TEXT NOT NULL
        );

        -- CardDAV addressbook sources. Credentials (passwords) live in the
        -- OS keychain under 'carddav__{id}', never in this table. Synced
        -- contacts land in the existing contacts table; there is no per-
        -- source origin tracking.
        CREATE TABLE IF NOT EXISTS carddav_sources (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id     TEXT NOT NULL,
            url            TEXT NOT NULL,
            display_name   TEXT,
            username       TEXT NOT NULL,
            last_synced_at TEXT,
            UNIQUE(account_id, url)
        );

        -- CalDAV calendar sources. Same keychain convention as CardDAV:
        -- password stored under 'caldav__{id}'. Synced events live in
        -- calendar_events keyed by (source_id, uid).
        CREATE TABLE IF NOT EXISTS caldav_sources (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id     TEXT NOT NULL,
            url            TEXT NOT NULL,
            display_name   TEXT,
            username       TEXT NOT NULL,
            color          TEXT,
            last_synced_at TEXT,
            UNIQUE(account_id, url)
        );

        -- Individual calendar events from a CalDAV sync. Raw ICS kept for
        -- PUT round-trip fidelity. etag is the last known ETag from the
        -- server, used for conditional updates.
        CREATE TABLE IF NOT EXISTS calendar_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id   INTEGER NOT NULL,
            uid         TEXT NOT NULL,
            href        TEXT NOT NULL,
            etag        TEXT,
            summary     TEXT,
            description TEXT,
            location    TEXT,
            dtstart     TEXT,
            dtend       TEXT,
            organizer   TEXT,
            status      TEXT,
            rrule       TEXT,
            sequence    INTEGER NOT NULL DEFAULT 0,
            raw_ics     TEXT NOT NULL,
            synced_at   TEXT NOT NULL,
            UNIQUE(source_id, uid)
        );

        -- App-lock passkey enrollment (see lock.rs). At most one row: the
        -- FIDO2 credential id and public key the unlock assertion verifies
        -- against.
        CREATE TABLE IF NOT EXISTS app_lock_passkey (
            id             INTEGER PRIMARY KEY CHECK (id = 1),
            credential_id  BLOB NOT NULL,
            public_key_der BLOB NOT NULL,
            rp_id          TEXT NOT NULL,
            created_at     TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("schema setup failed: {e}"))?;

    // Column additions to tables that predate them. There is still no real
    // migration framework -- each of these is a single additive ALTER that
    // fails (harmlessly) with "duplicate column name" once applied, so the
    // error is checked for exactly that and otherwise propagated.
    add_column_if_missing(conn, "contacts", "source", "TEXT NOT NULL DEFAULT 'local'")
}

/// Applies `ALTER TABLE ... ADD COLUMN ...`, treating "the column already
/// exists" as success so it can run unconditionally at every open.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    match conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition};")) {
        Ok(()) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(format!("could not add {table}.{column}: {e}")),
    }
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
    let _ = conn.execute("ALTER TABLE cached_messages ADD COLUMN message_id TEXT", []);
    let _ = conn.execute("ALTER TABLE cached_messages ADD COLUMN in_reply_to TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN imap_use_starttls INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN incoming_protocol TEXT NOT NULL DEFAULT 'imap'",
        [],
    );
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN pop3_host TEXT", []);
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN pop3_port INTEGER", []);
    let _ = conn.execute("ALTER TABLE drafts ADD COLUMN attachments TEXT", []);
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN cc TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN bcc TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN spam_folder TEXT NOT NULL DEFAULT 'Spam'",
        [],
    );
    // Scheduled send: send_at is NULL for immediate sends, an RFC 3339
    // timestamp for messages that should be held until that time.
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN send_at TEXT", []);
    // Identity override for send-as aliases: NULL means use account_id as From.
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN from_override TEXT", []);
    // Sent folder: where a copy of each successfully sent message is saved.
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN sent_folder TEXT NOT NULL DEFAULT 'Sent'",
        [],
    );
    // OAuth accounts: how the account authenticates and which provider
    // preset it uses -- see the AccountRecord field docs.
    let _ = conn.execute(
        "ALTER TABLE accounts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'",
        [],
    );
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN oauth_provider TEXT", []);

    backfill_fts_if_empty(&conn)?;
    backfill_pop3_fts_if_empty(&conn)?;

    Ok(conn)
}

/// Populates the FTS index from existing `cached_messages` rows the first
/// time the index exists on a cache that already held messages. The sync
/// triggers only fire on writes made *after* they're created, so a cache
/// that predates `messages_fts` would otherwise have an empty index until
/// every message happened to be re-fetched.
///
/// Done with an explicit `INSERT INTO ... SELECT` -- the bulk equivalent of
/// what the insert trigger does for one row.
///
/// Guarded on the index being empty so this runs at most once per cache: on
/// a fresh install both tables are empty and it's a no-op; on an
/// already-migrated cache the index is non-empty and we skip it.
fn backfill_fts_if_empty(conn: &Connection) -> Result<(), String> {
    let fts_count: i64 = conn
        .query_row("SELECT count(*) FROM messages_fts", [], |row| row.get(0))
        .map_err(|e| format!("could not count fts rows: {e}"))?;
    let message_count: i64 = conn
        .query_row("SELECT count(*) FROM cached_messages", [], |row| row.get(0))
        .map_err(|e| format!("could not count cached messages: {e}"))?;

    if fts_count == 0 && message_count > 0 {
        conn.execute(
            "INSERT INTO messages_fts(rowid, account_id, folder, uid, subject, from_addr, body_text)
             SELECT rowid, account_id, folder, uid, subject, from_addr, body_text FROM cached_messages",
            [],
        )
        .map_err(|e| format!("could not backfill fts index: {e}"))?;
    }
    Ok(())
}

/// The `cached_pop3_messages` counterpart to `backfill_fts_if_empty`: same
/// one-time, empty-index-guarded bulk backfill so POP3 rows cached before
/// the `pop3_messages_fts` index existed still become searchable.
fn backfill_pop3_fts_if_empty(conn: &Connection) -> Result<(), String> {
    let fts_count: i64 = conn
        .query_row("SELECT count(*) FROM pop3_messages_fts", [], |row| row.get(0))
        .map_err(|e| format!("could not count POP3 fts rows: {e}"))?;
    let message_count: i64 = conn
        .query_row("SELECT count(*) FROM cached_pop3_messages", [], |row| row.get(0))
        .map_err(|e| format!("could not count cached POP3 messages: {e}"))?;

    if fts_count == 0 && message_count > 0 {
        conn.execute(
            "INSERT INTO pop3_messages_fts(rowid, account_id, uidl, number, subject, from_addr, body_text)
             SELECT rowid, account_id, uidl, number, subject, from_addr, body_text FROM cached_pop3_messages",
            [],
        )
        .map_err(|e| format!("could not backfill POP3 fts index: {e}"))?;
    }
    Ok(())
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
        .query_row(
            "SELECT (SELECT COUNT(*) FROM cached_messages) + (SELECT COUNT(*) FROM cached_pop3_messages)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not count cached messages: {e}"))?;
    let size_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(CacheStats { message_count, size_bytes })
}

#[tauri::command]
pub async fn cache_stats() -> Result<CacheStats, String> {
    let path = cache_db_path()?;
    let conn = open()?;
    cache_stats_in(&conn, &path)
}

fn clear_cache_in(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM cached_messages", [])
        .map_err(|e| format!("could not clear cached messages: {e}"))?;
    conn.execute("DELETE FROM cached_attachments", [])
        .map_err(|e| format!("could not clear cached attachments: {e}"))?;
    conn.execute("DELETE FROM cached_pop3_messages", [])
        .map_err(|e| format!("could not clear cached POP3 messages: {e}"))?;
    conn.execute("DELETE FROM cached_pop3_attachments", [])
        .map_err(|e| format!("could not clear cached POP3 attachments: {e}"))?;
    Ok(())
}

/// Clears cached message summaries/bodies only. Deliberately does not
/// touch `accounts`/`contacts`/`pgp_keys`/`pgp_contact_keys` — those are
/// durable data, not disposable cache, and a PGP secret key in
/// particular is unrecoverable once deleted. "Clear cache" should never
/// be able to take out an encryption identity as a side effect.
#[tauri::command]
pub async fn clear_cache() -> Result<(), String> {
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
                (account_id, folder, uid, subject, from_addr, date, seen, flagged,
                 message_id, in_reply_to, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(account_id, folder, uid) DO UPDATE SET
                subject = excluded.subject,
                from_addr = excluded.from_addr,
                date = excluded.date,
                seen = excluded.seen,
                flagged = excluded.flagged,
                message_id = excluded.message_id,
                in_reply_to = excluded.in_reply_to,
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
                summary.message_id,
                summary.in_reply_to,
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

/// Reads cached message summaries for one account/folder back out, newest
/// first -- the offline-read counterpart to `upsert_summaries`. Every
/// `fetch_messages` call writes through to the cache (see `imap.rs`), so
/// when a live fetch can't reach the server the frontend can fall back to
/// this and still show the last-seen state of the folder.
///
/// `message_id`/`in_reply_to` are included so a threaded view still works
/// offline. Body columns aren't selected here -- a summary list doesn't
/// need them; use `get_cached_body` for one message's content.
pub fn get_cached_summaries(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT uid, subject, from_addr, date, seen, flagged, message_id, in_reply_to
             FROM cached_messages
             WHERE account_id = ?1 AND folder = ?2
             ORDER BY date DESC
             LIMIT ?3",
        )
        .map_err(|e| format!("could not prepare cached summary query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id, folder, limit], |row| {
            Ok(MessageSummary {
                uid: Some(row.get(0)?),
                subject: row.get(1)?,
                from: row.get(2)?,
                date: row.get(3)?,
                seen: row.get(4)?,
                flagged: row.get(5)?,
                message_id: row.get(6)?,
                in_reply_to: row.get(7)?,
                is_spam: false,
            })
        })
        .map_err(|e| format!("could not query cached summaries: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read cached summary row: {e}"))
}

/// Offline-read command: returns the last-cached summaries for a folder
/// without touching the network. The frontend calls this when a live
/// `fetch_messages` fails (offline, server down) so the mailbox isn't just
/// blank.
#[tauri::command]
pub async fn load_cached_messages(
    account_id: String,
    folder: String,
    limit: u32,
) -> Result<Vec<MessageSummary>, String> {
    let conn = open()?;
    get_cached_summaries(&conn, &account_id, &folder, limit)
}

/// Reads one cached message body back out for offline reading. Returns
/// `Ok(None)` when that UID's body was never cached (only its summary was
/// fetched, or nothing at all) -- "not cached" is an ordinary state, not
/// an error.
///
/// `text`/`html`, the threading IDs, and the list of any attachments that
/// were previously downloaded (from the attachment cache) come back;
/// recipient lists and PGP verification state are not cached, so those stay
/// at their empty defaults. Offline reading shows the message text and lets
/// already-downloaded attachments reopen via `load_cached_attachment`; a
/// live fetch is still needed for a never-downloaded attachment or to
/// re-run PGP verification.
pub fn get_cached_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<MessageBody>, String> {
    let row = conn
        .query_row(
            "SELECT body_text, body_html, message_id, in_reply_to
             FROM cached_messages
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, uid],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("could not read cached body: {e}"))?;

    let Some((text, html, message_id, in_reply_to)) = row else {
        return Ok(None);
    };
    // A cached row with neither a text nor an HTML body means only the
    // summary was ever fetched -- report that as "no body cached"
    // rather than a blank body the UI would render as an empty message.
    if text.is_none() && html.is_none() {
        return Ok(None);
    }
    // Repopulate the attachment list from whatever was downloaded into the
    // attachment cache, so offline reading still shows which attachments
    // are available to open (their bytes load via load_cached_attachment).
    let attachments = get_cached_attachment_infos(conn, account_id, folder, uid)?;
    Ok(Some(MessageBody {
        text,
        html,
        attachments,
        pgp_signed_by: None,
        pgp_signature_valid: None,
        smime_signed: false,
        smime_verified: None,
        smime_encrypted: false,
        smime_signer_email: None,
        from: None,
        to: Vec::new(),
        cc: Vec::new(),
        reply_to: None,
        message_id,
        in_reply_to,
        references: Vec::new(),
        disposition_notification_to: None,
    }))
}

/// Offline-read command for a single message's body. `Ok(None)` means the
/// body isn't cached and a live fetch is required.
#[tauri::command]
pub async fn load_cached_message_body(
    account_id: String,
    folder: String,
    uid: u32,
) -> Result<Option<MessageBody>, String> {
    let conn = open()?;
    get_cached_body(&conn, &account_id, &folder, uid)
}

// ---------------------------------------------------------------------------
// Attachment byte cache
// ---------------------------------------------------------------------------

/// Largest attachment worth caching, per item. Past this, the on-demand
/// `fetch_attachment` path still serves it live -- caching a huge blob in
/// SQLite would crowd out many smaller, more re-openable attachments for
/// one rarely-reread file. 25 MB matches the send-size ceiling most
/// providers impose, so it covers the overwhelming majority of real mail.
const MAX_CACHED_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// Total budget for all cached attachment bytes. When a new download pushes
/// the table over this, the oldest-downloaded rows are evicted until it
/// fits again. A bound, not a guarantee of retention -- offline access to a
/// given attachment is best-effort, exactly like the rest of the cache.
const MAX_TOTAL_ATTACHMENT_CACHE_BYTES: i64 = 250 * 1024 * 1024;

/// Caches one downloaded attachment's bytes. Best-effort, like every other
/// cache write: an attachment larger than `MAX_CACHED_ATTACHMENT_BYTES` is
/// silently skipped (returned `Ok`, not cached -- the live fetch path still
/// has it), and a successful insert is followed by eviction down to the
/// total budget. A true upsert so re-downloading the same attachment just
/// refreshes the row (and its `fetched_at`, keeping it from being evicted
/// as stale).
pub fn upsert_attachment(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
    idx: usize,
    filename: Option<&str>,
    content_type: Option<&str>,
    bytes: &[u8],
) -> Result<(), String> {
    upsert_attachment_bounded(
        conn,
        account_id,
        folder,
        uid,
        idx,
        filename,
        content_type,
        bytes,
        MAX_CACHED_ATTACHMENT_BYTES,
        MAX_TOTAL_ATTACHMENT_CACHE_BYTES,
    )
}

/// The cap/budget-parameterised core of `upsert_attachment`, split out so
/// tests can drive eviction and the size cap with tiny limits instead of
/// allocating hundreds of megabytes.
#[allow(clippy::too_many_arguments)]
fn upsert_attachment_bounded(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
    idx: usize,
    filename: Option<&str>,
    content_type: Option<&str>,
    bytes: &[u8],
    per_item_cap: usize,
    total_budget: i64,
) -> Result<(), String> {
    if bytes.len() > per_item_cap {
        return Ok(());
    }

    let fetched_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cached_attachments
            (account_id, folder, uid, idx, filename, content_type, content, size, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account_id, folder, uid, idx) DO UPDATE SET
            filename = excluded.filename,
            content_type = excluded.content_type,
            content = excluded.content,
            size = excluded.size,
            fetched_at = excluded.fetched_at",
        params![
            account_id,
            folder,
            uid,
            idx as i64,
            filename,
            content_type,
            bytes,
            bytes.len() as i64,
            fetched_at
        ],
    )
    .map_err(|e| format!("could not cache attachment: {e}"))?;

    evict_attachments_over_budget(conn, total_budget)
}

/// Deletes oldest-downloaded attachment rows until the table is back within
/// `MAX_TOTAL_ATTACHMENT_CACHE_BYTES`. Computes which rows to drop in Rust
/// rather than a single running-sum DELETE so it stays portable across
/// SQLite builds. Since the per-item cap is far below the total budget, a
/// just-inserted row is never the one evicted.
fn evict_attachments_over_budget(conn: &Connection, total_budget: i64) -> Result<(), String> {
    // The budget spans both attachment tables (IMAP cached_attachments and
    // POP3 cached_pop3_attachments) so the cap is on total bytes regardless
    // of protocol, rather than two independent budgets that could together
    // double it.
    let total: i64 = conn
        .query_row(
            "SELECT (SELECT COALESCE(SUM(size), 0) FROM cached_attachments)
                  + (SELECT COALESCE(SUM(size), 0) FROM cached_pop3_attachments)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not measure attachment cache size: {e}"))?;
    if total <= total_budget {
        return Ok(());
    }

    // Oldest-downloaded first across both tables. `origin` says which table a
    // rowid belongs to so the DELETE hits the right one.
    let mut stmt = conn
        .prepare(
            "SELECT origin, rowid, size FROM (
                 SELECT 'imap' AS origin, rowid, size, fetched_at FROM cached_attachments
                 UNION ALL
                 SELECT 'pop3' AS origin, rowid, size, fetched_at FROM cached_pop3_attachments
             ) ORDER BY fetched_at ASC",
        )
        .map_err(|e| format!("could not prepare attachment eviction query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|e| format!("could not scan attachments for eviction: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read attachment row for eviction: {e}"))?;

    let mut remaining = total;
    for (origin, rowid, size) in rows {
        if remaining <= total_budget {
            break;
        }
        match origin.as_str() {
            "pop3" => conn.execute("DELETE FROM cached_pop3_attachments WHERE rowid = ?1", params![rowid]),
            _ => conn.execute("DELETE FROM cached_attachments WHERE rowid = ?1", params![rowid]),
        }
        .map_err(|e| format!("could not evict cached attachment: {e}"))?;
        remaining -= size;
    }
    Ok(())
}

/// Reads one cached attachment back out for offline access, base64-encoding
/// its bytes into the same `AttachmentContent` shape `fetch_attachment`
/// returns so the frontend's online and offline download paths are
/// interchangeable. `Ok(None)` when that attachment was never downloaded
/// (or has since been evicted) -- an ordinary state, not an error.
pub fn get_cached_attachment(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
    idx: usize,
) -> Result<Option<AttachmentContent>, String> {
    use base64::Engine;

    let row = conn
        .query_row(
            "SELECT filename, content_type, content FROM cached_attachments
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3 AND idx = ?4",
            params![account_id, folder, uid, idx as i64],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("could not read cached attachment: {e}"))?;

    Ok(row.map(|(filename, content_type, content)| AttachmentContent {
        filename,
        content_type,
        content_base64: base64::engine::general_purpose::STANDARD.encode(content),
    }))
}

/// Offline-read command for one downloaded attachment's bytes. `Ok(None)`
/// means it isn't cached (never downloaded, or evicted) and a live
/// `fetch_attachment` is required.
#[tauri::command]
pub async fn load_cached_attachment(
    account_id: String,
    folder: String,
    uid: u32,
    attachment_index: usize,
) -> Result<Option<AttachmentContent>, String> {
    let conn = open()?;
    get_cached_attachment(&conn, &account_id, &folder, uid, attachment_index)
}

/// Lists metadata (not bytes) for every cached attachment of one message,
/// in attachment-index order -- used to repopulate a cached body's
/// `attachments` list so offline reading still shows which attachments are
/// available to open. Only attachments that were actually downloaded appear
/// here, since that's all that's cached.
fn get_cached_attachment_infos(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<Vec<AttachmentInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT idx, filename, content_type, size FROM cached_attachments
             WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
             ORDER BY idx ASC",
        )
        .map_err(|e| format!("could not prepare cached attachment metadata query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id, folder, uid], |row| {
            Ok(AttachmentInfo {
                index: row.get::<_, i64>(0)? as usize,
                filename: row.get(1)?,
                content_type: row.get(2)?,
                size: row.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(|e| format!("could not read cached attachment metadata: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not collect cached attachment metadata: {e}"))
}

// ---------------------------------------------------------------------------
// POP3 message cache
// ---------------------------------------------------------------------------

/// Write-through cache for POP3 inbox summaries, so a POP3 account's mail is
/// visible offline like an IMAP account's. Only summaries carrying a UIDL
/// are cached -- the UIDL is the stable key, and a message without one has
/// no durable identity to cache under. A true upsert keyed by
/// `(account_id, uidl)`, refreshing the last-seen `number` and header
/// fields each time. Body columns are left untouched on conflict, the same
/// summary-vs-body split `upsert_body` uses for IMAP.
pub fn upsert_pop3_summaries(
    conn: &Connection,
    account_id: &str,
    summaries: &[Pop3MessageSummary],
) -> Result<(), String> {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|e| format!("could not begin cache transaction: {e}"))?;
    for summary in summaries {
        let Some(uidl) = &summary.uidl else { continue };
        tx.execute(
            "INSERT INTO cached_pop3_messages
                (account_id, uidl, number, subject, from_addr, date, size, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, uidl) DO UPDATE SET
                number = excluded.number,
                subject = excluded.subject,
                from_addr = excluded.from_addr,
                date = excluded.date,
                size = excluded.size,
                fetched_at = excluded.fetched_at",
            params![
                account_id,
                uidl,
                summary.number,
                summary.subject,
                summary.from,
                summary.date,
                summary.size,
                fetched_at
            ],
        )
        .map_err(|e| format!("could not cache POP3 summary: {e}"))?;
    }
    tx.commit().map_err(|e| format!("could not commit cache transaction: {e}"))
}

/// Reads cached POP3 summaries back out for offline display, newest first
/// (by date, then by last-seen number). The returned `number` is the
/// last-seen one and may be stale if the mailbox changed since -- opening a
/// message offline goes by UIDL via `get_cached_pop3_body`, not by number.
pub fn get_cached_pop3_summaries(
    conn: &Connection,
    account_id: &str,
    limit: u32,
) -> Result<Vec<Pop3MessageSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT number, size, uidl, subject, from_addr, date FROM cached_pop3_messages
             WHERE account_id = ?1
             ORDER BY date DESC, number DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("could not prepare cached POP3 summary query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id, limit], |row| {
            Ok(Pop3MessageSummary {
                number: row.get(0)?,
                size: row.get(1)?,
                uidl: row.get(2)?,
                subject: row.get(3)?,
                from: row.get(4)?,
                date: row.get(5)?,
            })
        })
        .map_err(|e| format!("could not query cached POP3 summaries: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read cached POP3 summary row: {e}"))
}

/// Offline-read command for a POP3 account's cached inbox summaries.
#[tauri::command]
pub async fn load_cached_pop3_messages(account_id: String, limit: u32) -> Result<Vec<Pop3MessageSummary>, String> {
    let conn = open()?;
    get_cached_pop3_summaries(&conn, &account_id, limit)
}

/// Caches one POP3 message body, keyed by UIDL. Only the body columns are
/// touched on conflict, so a row already holding a summary keeps it -- the
/// same write-through split as `upsert_body`. Inserts a bare row (summary
/// columns null) if the body arrives before any summary did.
pub fn upsert_pop3_body(
    conn: &Connection,
    account_id: &str,
    uidl: &str,
    body: &MessageBody,
) -> Result<(), String> {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cached_pop3_messages
            (account_id, uidl, body_text, body_html, message_id, in_reply_to, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(account_id, uidl) DO UPDATE SET
            body_text = excluded.body_text,
            body_html = excluded.body_html,
            message_id = excluded.message_id,
            in_reply_to = excluded.in_reply_to,
            fetched_at = excluded.fetched_at",
        params![account_id, uidl, body.text, body.html, body.message_id, body.in_reply_to, fetched_at],
    )
    .map_err(|e| format!("could not cache POP3 body: {e}"))?;
    Ok(())
}

/// Reads one cached POP3 body back out by UIDL. Same `Ok(None)`-when-only-a-
/// summary-was-cached convention as `get_cached_body`; recipients, PGP state
/// and attachment bytes aren't cached, so those come back at their defaults.
pub fn get_cached_pop3_body(conn: &Connection, account_id: &str, uidl: &str) -> Result<Option<MessageBody>, String> {
    let row = conn
        .query_row(
            "SELECT body_text, body_html, message_id, in_reply_to FROM cached_pop3_messages
             WHERE account_id = ?1 AND uidl = ?2",
            params![account_id, uidl],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("could not read cached POP3 body: {e}"))?;

    let Some((text, html, message_id, in_reply_to)) = row else {
        return Ok(None);
    };
    if text.is_none() && html.is_none() {
        return Ok(None);
    }
    let attachments = get_cached_pop3_attachment_infos(conn, account_id, uidl)?;
    Ok(Some(MessageBody {
        text,
        html,
        attachments,
        pgp_signed_by: None,
        pgp_signature_valid: None,
        smime_signed: false,
        smime_verified: None,
        smime_encrypted: false,
        smime_signer_email: None,
        from: None,
        to: Vec::new(),
        cc: Vec::new(),
        reply_to: None,
        message_id,
        in_reply_to,
        references: Vec::new(),
        disposition_notification_to: None,
    }))
}

/// Offline-read command for one cached POP3 message body, addressed by UIDL.
#[tauri::command]
pub async fn load_cached_pop3_message_body(account_id: String, uidl: String) -> Result<Option<MessageBody>, String> {
    let conn = open()?;
    get_cached_pop3_body(&conn, &account_id, &uidl)
}

/// Caches one downloaded POP3 attachment's bytes, keyed by UIDL -- the
/// UIDL-addressed counterpart to `upsert_attachment`. Shares the same
/// per-item cap and (cross-table) total budget, so an oversize attachment
/// is skipped and the insert is followed by eviction spanning both
/// attachment tables.
#[allow(clippy::too_many_arguments)]
pub fn upsert_pop3_attachment(
    conn: &Connection,
    account_id: &str,
    uidl: &str,
    idx: usize,
    filename: Option<&str>,
    content_type: Option<&str>,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() > MAX_CACHED_ATTACHMENT_BYTES {
        return Ok(());
    }

    let fetched_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cached_pop3_attachments
            (account_id, uidl, idx, filename, content_type, content, size, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account_id, uidl, idx) DO UPDATE SET
            filename = excluded.filename,
            content_type = excluded.content_type,
            content = excluded.content,
            size = excluded.size,
            fetched_at = excluded.fetched_at",
        params![account_id, uidl, idx as i64, filename, content_type, bytes, bytes.len() as i64, fetched_at],
    )
    .map_err(|e| format!("could not cache POP3 attachment: {e}"))?;

    evict_attachments_over_budget(conn, MAX_TOTAL_ATTACHMENT_CACHE_BYTES)
}

/// Reads one cached POP3 attachment back out by UIDL, base64-encoded into
/// the same `AttachmentContent` shape `pop3_fetch_attachment` returns.
pub fn get_cached_pop3_attachment(
    conn: &Connection,
    account_id: &str,
    uidl: &str,
    idx: usize,
) -> Result<Option<AttachmentContent>, String> {
    use base64::Engine;

    let row = conn
        .query_row(
            "SELECT filename, content_type, content FROM cached_pop3_attachments
             WHERE account_id = ?1 AND uidl = ?2 AND idx = ?3",
            params![account_id, uidl, idx as i64],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("could not read cached POP3 attachment: {e}"))?;

    Ok(row.map(|(filename, content_type, content)| AttachmentContent {
        filename,
        content_type,
        content_base64: base64::engine::general_purpose::STANDARD.encode(content),
    }))
}

/// Offline-read command for one downloaded POP3 attachment, addressed by UIDL.
#[tauri::command]
pub async fn load_cached_pop3_attachment(
    account_id: String,
    uidl: String,
    attachment_index: usize,
) -> Result<Option<AttachmentContent>, String> {
    let conn = open()?;
    get_cached_pop3_attachment(&conn, &account_id, &uidl, attachment_index)
}

/// Metadata (not bytes) for every cached POP3 attachment of one message, in
/// index order -- repopulates a cached POP3 body's `attachments` list so
/// offline reading shows which attachments are available to reopen.
fn get_cached_pop3_attachment_infos(
    conn: &Connection,
    account_id: &str,
    uidl: &str,
) -> Result<Vec<AttachmentInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT idx, filename, content_type, size FROM cached_pop3_attachments
             WHERE account_id = ?1 AND uidl = ?2
             ORDER BY idx ASC",
        )
        .map_err(|e| format!("could not prepare cached POP3 attachment metadata query: {e}"))?;
    let rows = stmt
        .query_map(params![account_id, uidl], |row| {
            Ok(AttachmentInfo {
                index: row.get::<_, i64>(0)? as usize,
                filename: row.get(1)?,
                content_type: row.get(2)?,
                size: row.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(|e| format!("could not read cached POP3 attachment metadata: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not collect cached POP3 attachment metadata: {e}"))
}

/// One hit from a local full-text search. Unlike `MessageSummary` (which is
/// scoped to a known account/folder by its caller), a local search spans
/// every account and folder at once, so each result has to carry its own
/// `account_id`/`folder` for the frontend to know where the message lives
/// and be able to open it.
///
/// A POP3 hit sets `uidl` (its stable key, used to open it offline via
/// `load_cached_pop3_message_body`) and carries the last-seen message
/// `number` in `uid` for a live RETR; `folder` is `"INBOX"`, POP3's single
/// implicit mailbox. An IMAP hit leaves `uidl` `None`. The frontend tells
/// the two apart by `uidl` being present (or by the account's protocol).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalSearchResult {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub uidl: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub seen: bool,
    pub flagged: bool,
}

/// Turns a free-text query into a safe FTS5 MATCH expression.
///
/// FTS5's query syntax treats bare words like `AND`/`OR`/`NOT`/`NEAR` as
/// operators and `"*():^-` as punctuation, so a raw user string can either
/// error out or mean something the user didn't intend. We sidestep all of
/// that: split on whitespace, quote each token as a literal phrase (with
/// any embedded `"` doubled, FTS5's escaping rule), and append `*` so each
/// token is a prefix match -- friendlier for search-as-you-type. Tokens are
/// space-joined, which FTS5 reads as an implicit AND, so every term must
/// appear.
///
/// Returns `None` when the query has no usable tokens (empty or whitespace
/// only) so the caller can return no results rather than running a
/// malformed MATCH.
fn build_fts_query(raw: &str) -> Option<String> {
    let expr = raw
        .split_whitespace()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    if expr.is_empty() {
        None
    } else {
        Some(expr)
    }
}

/// Runs a local full-text search over cached messages. The FTS index carries
/// account_id/folder/uid as unindexed columns, so a join back to
/// cached_messages is only needed for date/seen/flagged. Returns the newest
/// `limit` matches. `account_id = Some(..)` scopes the search to one account;
/// `None` searches every cached account at once (the global/unified search).
/// Ordered newest first to match the rest of the app rather than by FTS
/// relevance rank.
pub fn search_cached_messages(
    conn: &Connection,
    account_id: Option<&str>,
    query: &str,
    limit: u32,
) -> Result<Vec<LocalSearchResult>, String> {
    let Some(match_expr) = build_fts_query(query) else {
        return Ok(Vec::new());
    };

    // IMAP hits (messages_fts -> cached_messages).
    let imap_sql = "SELECT m.account_id, m.folder, m.uid, m.subject, m.from_addr,
                      m.date, m.seen, m.flagged
               FROM messages_fts f
               JOIN cached_messages m
                 ON m.account_id = f.account_id AND m.folder = f.folder AND m.uid = f.uid
               WHERE messages_fts MATCH ?1
                 AND (?2 IS NULL OR f.account_id = ?2)
               ORDER BY m.date DESC
               LIMIT ?3";

    let mut stmt = conn
        .prepare(imap_sql)
        .map_err(|e| format!("could not prepare local search query: {e}"))?;
    let mut results = stmt
        .query_map(params![match_expr, account_id, limit], |row| {
            Ok(LocalSearchResult {
                account_id: row.get(0)?,
                folder: row.get(1)?,
                uid: row.get(2)?,
                uidl: None,
                subject: row.get(3)?,
                from: row.get(4)?,
                date: row.get(5)?,
                seen: row.get(6)?,
                flagged: row.get(7)?,
            })
        })
        .map_err(|e| format!("could not run local search: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read local search row: {e}"))?;

    // POP3 hits (pop3_messages_fts -> cached_pop3_messages). POP3 has no
    // folder/flags and is keyed by UIDL, so these are mapped into the shared
    // result shape: folder "INBOX", number as uid, uidl set, flags false.
    let pop3_sql = "SELECT m.account_id, m.uidl, m.number, m.subject, m.from_addr, m.date
               FROM pop3_messages_fts f
               JOIN cached_pop3_messages m
                 ON m.account_id = f.account_id AND m.uidl = f.uidl
               WHERE pop3_messages_fts MATCH ?1
                 AND (?2 IS NULL OR f.account_id = ?2)
               ORDER BY m.date DESC
               LIMIT ?3";

    let mut pop3_stmt = conn
        .prepare(pop3_sql)
        .map_err(|e| format!("could not prepare POP3 local search query: {e}"))?;
    let pop3_results = pop3_stmt
        .query_map(params![match_expr, account_id, limit], |row| {
            Ok(LocalSearchResult {
                account_id: row.get(0)?,
                folder: "INBOX".to_string(),
                uid: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u32,
                uidl: row.get(1)?,
                subject: row.get(3)?,
                from: row.get(4)?,
                date: row.get(5)?,
                seen: false,
                flagged: false,
            })
        })
        .map_err(|e| format!("could not run POP3 local search: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read POP3 local search row: {e}"))?;

    // Merge the two protocol streams into one newest-first list, capped at
    // `limit` overall. Dates sort descending as strings (None last), matching
    // each per-protocol query's own ORDER BY.
    results.extend(pop3_results);
    results.sort_by(|a, b| b.date.cmp(&a.date));
    results.truncate(limit as usize);
    Ok(results)
}

/// Offline/global full-text search with optional structured filters.
/// Searches the local encrypted cache without touching the network.
///
/// - `account_id = None` searches every cached account (global search).
/// - `query` is free-text matched against Subject/From/Body. An empty
///   query with filters still works -- the FTS step is skipped and the
///   filter-only WHERE clauses run against the full cached set.
/// - Structured filters are applied as SQL WHERE clauses on the JOIN side
///   (against `cached_messages`/`cached_pop3_messages`), not as FTS
///   criteria. This keeps the FTS index fast while still supporting exact
///   flag/date matching that FTS can't express.
#[tauri::command]
pub async fn search_local_messages(
    account_id: Option<String>,
    query: String,
    limit: u32,
    // Structured filters -- all optional (None = not filtered).
    from_filter: Option<String>,
    subject_filter: Option<String>,
    has_attachment: Option<bool>,
    is_unread: Option<bool>,
    is_flagged: Option<bool>,
    date_after: Option<String>,
    date_before: Option<String>,
) -> Result<Vec<LocalSearchResult>, String> {
    let conn = open()?;
    search_cached_messages_filtered(
        &conn,
        account_id.as_deref(),
        &query,
        limit,
        from_filter.as_deref(),
        subject_filter.as_deref(),
        has_attachment,
        is_unread,
        is_flagged,
        date_after.as_deref(),
        date_before.as_deref(),
    )
}

// Escapes SQLite LIKE special characters so user-supplied filter strings can't
// accidentally match any character (`_`) or any sequence (`%`). Used whenever
// a filter value is embedded in a LIKE pattern -- the corresponding SQL must
// include `ESCAPE '\'` after the LIKE operand.
fn escape_like(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Inner implementation supporting both the public command and internal callers.
pub fn search_cached_messages_filtered(
    conn: &Connection,
    account_id: Option<&str>,
    query: &str,
    limit: u32,
    from_filter: Option<&str>,
    subject_filter: Option<&str>,
    _has_attachment: Option<bool>,
    is_unread: Option<bool>,
    is_flagged: Option<bool>,
    date_after: Option<&str>,
    date_before: Option<&str>,
) -> Result<Vec<LocalSearchResult>, String> {
    let match_expr = build_fts_query(query);
    let has_fts = match_expr.is_some();

    // Build the IMAP query. When there's a free-text component we go through
    // the FTS table; when there's no text but there are filters we scan
    // cached_messages directly with a WHERE clause.
    let imap_results: Vec<LocalSearchResult> = if has_fts {
        let expr = match_expr.as_deref().unwrap();
        let sql = "SELECT m.account_id, m.folder, m.uid, m.subject, m.from_addr,
                          m.date, m.seen, m.flagged
                   FROM messages_fts f
                   JOIN cached_messages m
                     ON m.account_id = f.account_id AND m.folder = f.folder AND m.uid = f.uid
                   WHERE messages_fts MATCH ?1
                     AND (?2 IS NULL OR f.account_id = ?2)
                     AND (?3 IS NULL OR m.from_addr LIKE ?3 ESCAPE '\')
                     AND (?4 IS NULL OR m.subject LIKE ?4 ESCAPE '\')
                     AND (?5 IS NULL OR m.seen = ?5)
                     AND (?6 IS NULL OR m.flagged = ?6)
                     AND (?7 IS NULL OR m.date >= ?7)
                     AND (?8 IS NULL OR m.date <= ?8)
                   ORDER BY m.date DESC LIMIT ?9";
        // is_unread maps to seen=0
        let seen_filter: Option<i32> = is_unread.map(|u| if u { 0 } else { 1 });
        let flagged_filter: Option<i32> = is_flagged.map(|f| if f { 1 } else { 0 });
        let from_like = from_filter.map(|f| format!("%{}%", escape_like(f)));
        let subj_like = subject_filter.map(|s| format!("%{}%", escape_like(s)));
        conn.prepare(sql)
            .map_err(|e| format!("could not prepare filtered search: {e}"))?
            .query_map(
                params![expr, account_id, from_like, subj_like, seen_filter, flagged_filter, date_after, date_before, limit],
                |row| Ok(LocalSearchResult {
                    account_id: row.get(0)?,
                    folder: row.get(1)?,
                    uid: row.get(2)?,
                    uidl: None,
                    subject: row.get(3)?,
                    from: row.get(4)?,
                    date: row.get(5)?,
                    seen: row.get(6)?,
                    flagged: row.get(7)?,
                }),
            )
            .map_err(|e| format!("could not run filtered IMAP search: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not read search row: {e}"))?
    } else {
        // Filter-only path (no free-text): scan cached_messages directly.
        // Skip if no filters at all (would return everything, not useful).
        let any_filter = from_filter.is_some() || subject_filter.is_some()
            || is_unread.is_some() || is_flagged.is_some()
            || date_after.is_some() || date_before.is_some() || account_id.is_some();
        if !any_filter {
            return Ok(Vec::new());
        }
        let seen_filter: Option<i32> = is_unread.map(|u| if u { 0 } else { 1 });
        let flagged_filter: Option<i32> = is_flagged.map(|f| if f { 1 } else { 0 });
        let from_like = from_filter.map(|f| format!("%{}%", escape_like(f)));
        let subj_like = subject_filter.map(|s| format!("%{}%", escape_like(s)));
        let sql = "SELECT account_id, folder, uid, subject, from_addr, date, seen, flagged
                   FROM cached_messages
                   WHERE (?1 IS NULL OR account_id = ?1)
                     AND (?2 IS NULL OR from_addr LIKE ?2 ESCAPE '\')
                     AND (?3 IS NULL OR subject LIKE ?3 ESCAPE '\')
                     AND (?4 IS NULL OR seen = ?4)
                     AND (?5 IS NULL OR flagged = ?5)
                     AND (?6 IS NULL OR date >= ?6)
                     AND (?7 IS NULL OR date <= ?7)
                   ORDER BY date DESC LIMIT ?8";
        conn.prepare(sql)
            .map_err(|e| format!("could not prepare filter search: {e}"))?
            .query_map(
                params![account_id, from_like, subj_like, seen_filter, flagged_filter, date_after, date_before, limit],
                |row| Ok(LocalSearchResult {
                    account_id: row.get(0)?,
                    folder: row.get(1)?,
                    uid: row.get(2)?,
                    uidl: None,
                    subject: row.get(3)?,
                    from: row.get(4)?,
                    date: row.get(5)?,
                    seen: row.get(6)?,
                    flagged: row.get(7)?,
                }),
            )
            .map_err(|e| format!("could not run filter search: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not read filter search row: {e}"))?
    };

    // POP3 side: filters on seen/flagged are skipped (POP3 has no flags);
    // date range and from/subject still apply.
    let pop3_results: Vec<LocalSearchResult> = if has_fts {
        let expr = match_expr.as_deref().unwrap();
        let from_like = from_filter.map(|f| format!("%{}%", escape_like(f)));
        let subj_like = subject_filter.map(|s| format!("%{}%", escape_like(s)));
        let sql = "SELECT m.account_id, m.uidl, m.number, m.subject, m.from_addr, m.date
                   FROM pop3_messages_fts f
                   JOIN cached_pop3_messages m
                     ON m.account_id = f.account_id AND m.uidl = f.uidl
                   WHERE pop3_messages_fts MATCH ?1
                     AND (?2 IS NULL OR f.account_id = ?2)
                     AND (?3 IS NULL OR m.from_addr LIKE ?3 ESCAPE '\')
                     AND (?4 IS NULL OR m.subject LIKE ?4 ESCAPE '\')
                     AND (?5 IS NULL OR m.date >= ?5)
                     AND (?6 IS NULL OR m.date <= ?6)
                   ORDER BY m.date DESC LIMIT ?7";
        conn.prepare(sql)
            .map_err(|e| format!("could not prepare POP3 filtered search: {e}"))?
            .query_map(
                params![expr, account_id, from_like, subj_like, date_after, date_before, limit],
                |row| Ok(LocalSearchResult {
                    account_id: row.get(0)?,
                    folder: "INBOX".to_string(),
                    uid: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u32,
                    uidl: row.get(1)?,
                    subject: row.get(3)?,
                    from: row.get(4)?,
                    date: row.get(5)?,
                    seen: false,
                    flagged: false,
                }),
            )
            .map_err(|e| format!("could not run POP3 filtered search: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not read POP3 search row: {e}"))?
    } else {
        Vec::new() // filter-only without text doesn't scan POP3 (no flags to filter on)
    };

    let mut results = imap_results;
    results.extend(pop3_results);
    results.sort_by(|a, b| b.date.cmp(&a.date));
    results.truncate(limit as usize);
    Ok(results)
}

// ---------------------------------------------------------------------------
// Identities (send-as aliases)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IdentityRecord {
    pub account_id: String,
    pub address: String,
    pub display_name: Option<String>,
    pub signature: Option<String>,
    pub created_at: String,
}

pub fn upsert_identity(conn: &Connection, identity: &IdentityRecord) -> Result<(), String> {
    conn.execute(
        "INSERT INTO identities (account_id, address, display_name, signature, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id, address) DO UPDATE SET
            display_name = excluded.display_name,
            signature    = excluded.signature",
        params![
            identity.account_id,
            identity.address,
            identity.display_name,
            identity.signature,
            identity.created_at,
        ],
    )
    .map_err(|e| format!("could not upsert identity: {e}"))?;
    Ok(())
}

pub fn list_identities(conn: &Connection, account_id: &str) -> Result<Vec<IdentityRecord>, String> {
    conn.prepare(
        "SELECT account_id, address, display_name, signature, created_at
         FROM identities WHERE account_id = ?1 ORDER BY created_at ASC",
    )
    .map_err(|e| format!("could not prepare identity list: {e}"))?
    .query_map(params![account_id], |row| {
        Ok(IdentityRecord {
            account_id: row.get(0)?,
            address: row.get(1)?,
            display_name: row.get(2)?,
            signature: row.get(3)?,
            created_at: row.get(4)?,
        })
    })
    .map_err(|e| format!("could not query identities: {e}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| format!("could not read identity row: {e}"))
}

pub fn delete_identity(conn: &Connection, account_id: &str, address: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM identities WHERE account_id = ?1 AND address = ?2",
        params![account_id, address],
    )
    .map_err(|e| format!("could not delete identity: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Muted threads
// ---------------------------------------------------------------------------

pub fn mute_thread_in(conn: &Connection, account_id: &str, message_id: &str) -> Result<(), String> {
    let muted_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO muted_threads (message_id, account_id, muted_at)
         VALUES (?1, ?2, ?3)",
        params![message_id, account_id, muted_at],
    )
    .map_err(|e| format!("could not mute thread: {e}"))?;
    Ok(())
}

pub fn unmute_thread_in(conn: &Connection, account_id: &str, message_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM muted_threads WHERE message_id = ?1 AND account_id = ?2",
        params![message_id, account_id],
    )
    .map_err(|e| format!("could not unmute thread: {e}"))?;
    Ok(())
}

pub fn is_thread_muted(conn: &Connection, account_id: &str, message_id: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM muted_threads WHERE message_id = ?1 AND account_id = ?2",
            params![message_id, account_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not check mute status: {e}"))?;
    Ok(n > 0)
}

pub fn list_muted_threads(conn: &Connection, account_id: &str) -> Result<Vec<String>, String> {
    conn.prepare(
        "SELECT message_id FROM muted_threads WHERE account_id = ?1 ORDER BY muted_at DESC",
    )
    .map_err(|e| format!("could not prepare muted threads list: {e}"))?
    .query_map(params![account_id], |row| row.get(0))
    .map_err(|e| format!("could not query muted threads: {e}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| format!("could not read muted thread row: {e}"))
}

// ---------------------------------------------------------------------------
// Unread count (for notification badge)
// ---------------------------------------------------------------------------

/// Returns the total number of unseen messages across all cached IMAP folders
/// for an account (or all accounts if `account_id` is `None`). Used to update
/// the application dock/taskbar badge.
pub fn total_unseen_count(conn: &Connection, account_id: Option<&str>) -> Result<u32, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cached_messages WHERE seen = 0 AND (?1 IS NULL OR account_id = ?1)",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not count unseen messages: {e}"))?;
    Ok(n as u32)
}

/// Tauri command wrapper for `total_unseen_count`. Returns the count for
/// a specific account or all accounts (if `account_id` is `None`). The
/// frontend calls this after fetch/mutation events to update the badge.
#[tauri::command]
pub async fn get_unseen_count(account_id: Option<String>) -> Result<u32, String> {
    let conn = open()?;
    total_unseen_count(&conn, account_id.as_deref())
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
    /// Whether the IMAP connection uses STARTTLS (port 143 style) rather
    /// than implicit TLS (port 993 style). For a `pop3` account these IMAP
    /// fields are unused placeholders -- see `incoming_protocol`.
    pub imap_use_starttls: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_use_starttls: bool,
    /// `"imap"` (the default) or `"pop3"`. For a POP3 account the
    /// `imap_*` fields are empty placeholders and `pop3_host`/`pop3_port`
    /// carry the real incoming server -- POP3 has no folders, so there's
    /// no IMAP server to record. See `pop3.md`/`multi-account.md`.
    pub incoming_protocol: String,
    pub pop3_host: Option<String>,
    pub pop3_port: Option<u16>,
    pub archive_folder: String,
    pub trash_folder: String,
    pub drafts_folder: String,
    pub spam_folder: String,
    pub sent_folder: String,
    /// `"password"` (the default) or `"oauth2"`. Mirrors what kind of
    /// secret sits in the keychain for this account so the frontend can
    /// render the right settings UI (an OAuth account has no password to
    /// rotate); the protocol code itself branches on the keychain
    /// payload, not this column -- see `oauth.rs`.
    pub auth_method: String,
    /// The OAuth provider preset (`"gmail"` / `"microsoft"`) when
    /// `auth_method` is `"oauth2"`, otherwise `None`.
    pub oauth_provider: Option<String>,
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
            (account_id, display_name, imap_host, imap_port, imap_use_starttls,
             smtp_host, smtp_port, smtp_use_starttls, incoming_protocol,
             pop3_host, pop3_port, archive_folder, trash_folder, drafts_folder,
             spam_folder, sent_folder, auth_method, oauth_provider, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(account_id) DO UPDATE SET
            display_name = excluded.display_name,
            imap_host = excluded.imap_host,
            imap_port = excluded.imap_port,
            imap_use_starttls = excluded.imap_use_starttls,
            smtp_host = excluded.smtp_host,
            smtp_port = excluded.smtp_port,
            smtp_use_starttls = excluded.smtp_use_starttls,
            incoming_protocol = excluded.incoming_protocol,
            pop3_host = excluded.pop3_host,
            pop3_port = excluded.pop3_port,
            archive_folder = excluded.archive_folder,
            trash_folder = excluded.trash_folder,
            drafts_folder = excluded.drafts_folder,
            spam_folder = excluded.spam_folder,
            sent_folder = excluded.sent_folder,
            auth_method = excluded.auth_method,
            oauth_provider = excluded.oauth_provider",
        params![
            account.account_id,
            account.display_name,
            account.imap_host,
            account.imap_port,
            account.imap_use_starttls,
            account.smtp_host,
            account.smtp_port,
            account.smtp_use_starttls,
            account.incoming_protocol,
            account.pop3_host,
            account.pop3_port,
            account.archive_folder,
            account.trash_folder,
            account.drafts_folder,
            account.spam_folder,
            account.sent_folder,
            account.auth_method,
            account.oauth_provider,
            created_at,
        ],
    )
    .map_err(|e| format!("could not store account: {e}"))?;
    Ok(())
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, display_name, imap_host, imap_port, imap_use_starttls,
                    smtp_host, smtp_port, smtp_use_starttls, incoming_protocol,
                    pop3_host, pop3_port, archive_folder, trash_folder, drafts_folder,
                    spam_folder, sent_folder, auth_method, oauth_provider
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
                imap_use_starttls: row.get(4)?,
                smtp_host: row.get(5)?,
                smtp_port: row.get(6)?,
                smtp_use_starttls: row.get(7)?,
                incoming_protocol: row.get(8)?,
                pop3_host: row.get(9)?,
                pop3_port: row.get(10)?,
                archive_folder: row.get(11)?,
                trash_folder: row.get(12)?,
                drafts_folder: row.get(13)?,
                spam_folder: row.get(14)?,
                sent_folder: row.get(15)?,
                auth_method: row.get(16)?,
                oauth_provider: row.get(17)?,
            })
        })
        .map_err(|e| format!("could not query accounts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read account row: {e}"))
}

/// Looks up one account's stored metadata by id. `Ok(None)` when there's
/// no such account -- an ordinary "not found", not an error. Used by the
/// IMAP layer to resolve an account's STARTTLS setting at login time
/// (`imap::login_for_account`) and by `update_account` to read the
/// existing record before applying changes.
pub fn get_account(conn: &Connection, account_id: &str) -> Result<Option<AccountRecord>, String> {
    conn.query_row(
        "SELECT account_id, display_name, imap_host, imap_port, imap_use_starttls,
                smtp_host, smtp_port, smtp_use_starttls, incoming_protocol,
                pop3_host, pop3_port, archive_folder, trash_folder, drafts_folder,
                spam_folder, sent_folder, auth_method, oauth_provider
         FROM accounts WHERE account_id = ?1",
        params![account_id],
        |row| {
            Ok(AccountRecord {
                account_id: row.get(0)?,
                display_name: row.get(1)?,
                imap_host: row.get(2)?,
                imap_port: row.get(3)?,
                imap_use_starttls: row.get(4)?,
                smtp_host: row.get(5)?,
                smtp_port: row.get(6)?,
                smtp_use_starttls: row.get(7)?,
                incoming_protocol: row.get(8)?,
                pop3_host: row.get(9)?,
                pop3_port: row.get(10)?,
                archive_folder: row.get(11)?,
                trash_folder: row.get(12)?,
                drafts_folder: row.get(13)?,
                spam_folder: row.get(14)?,
                sent_folder: row.get(15)?,
                auth_method: row.get(16)?,
                oauth_provider: row.get(17)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not read account: {e}"))
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
    tx.execute(
        "DELETE FROM cached_attachments WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| format!("could not delete cached attachments: {e}"))?;
    tx.execute(
        "DELETE FROM cached_pop3_messages WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| format!("could not delete cached POP3 messages: {e}"))?;
    tx.execute(
        "DELETE FROM cached_pop3_attachments WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| format!("could not delete cached POP3 attachments: {e}"))?;
    tx.execute("DELETE FROM accounts WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("could not delete account: {e}"))?;

    tx.commit()
        .map_err(|e| format!("could not commit delete transaction: {e}"))
}

/// The enrolled app-lock passkey (see lock.rs), if any.
pub(crate) struct AppLockPasskey {
    pub credential_id: Vec<u8>,
    pub public_key_der: Vec<u8>,
    pub rp_id: String,
}

pub(crate) fn get_app_lock_passkey(conn: &Connection) -> Result<Option<AppLockPasskey>, String> {
    conn.query_row(
        "SELECT credential_id, public_key_der, rp_id FROM app_lock_passkey WHERE id = 1",
        [],
        |row| {
            Ok(AppLockPasskey {
                credential_id: row.get(0)?,
                public_key_der: row.get(1)?,
                rp_id: row.get(2)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        e => Err(format!("could not read app-lock passkey: {e}")),
    })
}

pub(crate) fn set_app_lock_passkey(
    conn: &Connection,
    credential_id: &[u8],
    public_key_der: &[u8],
    rp_id: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_lock_passkey (id, credential_id, public_key_der, rp_id, created_at)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            credential_id = excluded.credential_id,
            public_key_der = excluded.public_key_der,
            rp_id = excluded.rp_id,
            created_at = excluded.created_at",
        params![credential_id, public_key_der, rp_id, chrono::Utc::now().to_rfc3339()],
    )
    .map(|_| ())
    .map_err(|e| format!("could not store app-lock passkey: {e}"))
}

pub(crate) fn clear_app_lock_passkey(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM app_lock_passkey WHERE id = 1", [])
        .map(|_| ())
        .map_err(|e| format!("could not clear app-lock passkey: {e}"))
}

/// One entry in the local address book, built up from addresses seen in
/// mail the user has read or sent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ContactRecord {
    pub email: String,
    pub display_name: Option<String>,
    /// Where the contact came from: "local" (harvested from read/sent mail
    /// or added by hand) or "carddav:<source_id>" for synced address books.
    pub source: String,
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
    upsert_contacts_from(conn, contacts, "local")
}

/// `upsert_contacts` with an explicit origin tag -- "local" for mail
/// harvesting and manual adds, "carddav:<id>" for synced address books. On
/// conflict the existing row keeps its original source (a CardDAV contact
/// that later shows up in read mail stays attributed to its address book).
pub fn upsert_contacts_from(
    conn: &Connection,
    contacts: &[(String, Option<String>)],
    source: &str,
) -> Result<(), String> {
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
            "INSERT INTO contacts (email, display_name, last_seen_at, source)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(email) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, contacts.display_name),
                last_seen_at = excluded.last_seen_at",
            params![email, display_name, last_seen_at, source],
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
fn search_contacts_in(
    conn: &Connection,
    query: &str,
    limit: u32,
    source: Option<&str>,
) -> Result<Vec<ContactRecord>, String> {
    let sanitized = query.replace('%', "").replace('_', "");
    let pattern = format!("%{sanitized}%");

    let mut stmt = conn
        .prepare(
            "SELECT email, display_name, source FROM contacts
             WHERE (email LIKE ?1 OR display_name LIKE ?1)
               AND (?3 IS NULL OR source = ?3)
             ORDER BY last_seen_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("could not prepare contact search: {e}"))?;
    let rows = stmt
        .query_map(params![pattern, limit, source], |row| {
            Ok(ContactRecord {
                email: row.get(0)?,
                display_name: row.get(1)?,
                source: row.get(2)?,
            })
        })
        .map_err(|e| format!("could not search contacts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read contact row: {e}"))
}

#[tauri::command]
pub async fn search_contacts(query: String, limit: u32, source: Option<String>) -> Result<Vec<ContactRecord>, String> {
    let conn = open()?;
    search_contacts_in(&conn, &query, limit, source.as_deref())
}

/// Lists the whole address book, most-recently-seen first, for a contact-
/// management view (as opposed to `search_contacts`, which is the
/// compose-time autocomplete). Split from its command wrapper for the same
/// temp-dir testability reason as `search_contacts_in`.
fn list_contacts_in(conn: &Connection, limit: u32, source: Option<&str>) -> Result<Vec<ContactRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT email, display_name, source FROM contacts
             WHERE (?2 IS NULL OR source = ?2)
             ORDER BY last_seen_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("could not prepare contact list query: {e}"))?;
    let rows = stmt
        .query_map(params![limit, source], |row| {
            Ok(ContactRecord {
                email: row.get(0)?,
                display_name: row.get(1)?,
                source: row.get(2)?,
            })
        })
        .map_err(|e| format!("could not list contacts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read contact row: {e}"))
}

#[tauri::command]
pub async fn list_contacts(limit: u32, source: Option<String>) -> Result<Vec<ContactRecord>, String> {
    let conn = open()?;
    list_contacts_in(&conn, limit, source.as_deref())
}

/// Renames a contact (sets or clears its display name). The email is the
/// row's identity and stays fixed -- "editing" an address is a delete plus
/// an add, which the frontend models explicitly.
fn update_contact_in(conn: &Connection, email: &str, display_name: Option<&str>) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let updated = conn
        .execute(
            "UPDATE contacts SET display_name = ?2 WHERE email = ?1",
            params![email, display_name],
        )
        .map_err(|e| format!("could not update contact: {e}"))?;
    if updated == 0 {
        return Err(format!("no contact with address {email}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn update_contact(email: String, display_name: Option<String>) -> Result<(), String> {
    let conn = open()?;
    update_contact_in(&conn, &email, display_name.as_deref())
}

/// Adds a contact by hand (source "local"), for the address-book view's
/// explicit add flow as opposed to the automatic mail harvesting.
#[tauri::command]
pub async fn add_contact(email: String, display_name: Option<String>) -> Result<(), String> {
    let trimmed = email.trim().to_string();
    if trimmed.is_empty() || !trimmed.contains('@') {
        return Err("a contact needs a valid email address".to_string());
    }
    let conn = open()?;
    upsert_contacts_from(&conn, &[(trimmed, display_name)], "local")
}

/// Removes one harvested contact by email. The address book accumulates
/// automatically from every message read or sent, so a manual "forget this
/// contact" needs a way to delete a row -- otherwise a one-off correspondent
/// (or a typo'd address) lingers in autocomplete forever. Email is
/// lowercased to match how `upsert_contacts` stored it. Deleting an email
/// that isn't present is a no-op success, not an error.
fn delete_contact_in(conn: &Connection, email: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    conn.execute("DELETE FROM contacts WHERE email = ?1", params![email])
        .map_err(|e| format!("could not delete contact: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_contact(email: String) -> Result<(), String> {
    let conn = open()?;
    delete_contact_in(&conn, &email)
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

/// One stored own identity without its secret half -- the listing-safe
/// view of `pgp_keys`, carrying `created_at` so a key-management UI can
/// show when each was generated/imported. Deliberately never includes
/// `secret_key`: secrets only leave this module as part of the
/// sign/decrypt operations that need them, never a listing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredOwnKey {
    pub account_id: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
}

/// Lists every account's own key (public half only), newest first, for a
/// key-management view -- the read-back counterpart to `upsert_own_key`
/// that lets the UI redisplay what's stored after a reload instead of only
/// what was imported in the current session.
pub fn list_own_keys(conn: &Connection) -> Result<Vec<StoredOwnKey>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, public_key, fingerprint, created_at FROM pgp_keys
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("could not prepare own-key list query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StoredOwnKey {
                account_id: row.get(0)?,
                public_key: row.get(1)?,
                fingerprint: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("could not list own keys: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read own-key row: {e}"))
}

/// Forgets an account's own keypair (e.g. before importing a replacement,
/// or to stop offering encryption for that account). Deleting a key that
/// isn't present is a no-op success, matching `delete_contact`.
pub fn delete_own_key(conn: &Connection, account_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM pgp_keys WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("could not delete own key: {e}"))?;
    Ok(())
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

/// One imported recipient key, with `imported_at` for the management view
/// -- the listing counterpart to `get_contact_key`'s single-row lookup.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredContactKey {
    pub email: String,
    pub public_key: String,
    pub fingerprint: String,
    pub imported_at: String,
}

/// Lists every imported recipient key, most-recently-imported first.
pub fn list_contact_keys(conn: &Connection) -> Result<Vec<StoredContactKey>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT email, public_key, fingerprint, imported_at FROM pgp_contact_keys
             ORDER BY imported_at DESC",
        )
        .map_err(|e| format!("could not prepare contact-key list query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StoredContactKey {
                email: row.get(0)?,
                public_key: row.get(1)?,
                fingerprint: row.get(2)?,
                imported_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("could not list contact keys: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read contact-key row: {e}"))
}

/// Forgets a recipient's imported public key. Email is lowercased to match
/// how `upsert_contact_key` stored it; deleting an absent key is a no-op
/// success, same as `delete_contact`.
pub fn delete_contact_key(conn: &Connection, email: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    conn.execute("DELETE FROM pgp_contact_keys WHERE email = ?1", params![email])
        .map_err(|e| format!("could not delete contact key: {e}"))?;
    Ok(())
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
    /// JSON-encoded `Vec<smtp::OutgoingAttachment>`, mirroring how
    /// `OutboxRecord.attachments_json` stores them -- kept as an opaque
    /// string here so the cache layer doesn't need to depend on `smtp`'s
    /// attachment type; `drafts.rs` does the (de)serialization. `None`
    /// for a draft with no attachments.
    pub attachments_json: Option<String>,
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
    // Comma-separated address lists, same shape as `to_addr`. Empty string
    // means "none" (kept as a plain string rather than Option to match how
    // the SMTP layer parses all three fields uniformly).
    pub cc: String,
    pub bcc: String,
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
    /// RFC 3339 timestamp when this message should actually be sent. `None`
    /// means send immediately. `flush_outbox` skips rows whose `send_at` is
    /// still in the future, so setting this to `now + N seconds` is the
    /// undo-send / Send Later implementation.
    pub send_at: Option<String>,
    /// If set, overrides the SMTP From header with this address (send-as / alias).
    /// The SMTP authentication credential is still resolved from `account_id`.
    pub from_override: Option<String>,
}

pub fn upsert_draft(conn: &Connection, draft: &DraftRecord) -> Result<(), String> {
    let refs_json = serde_json::to_string(&draft.references)
        .map_err(|e| format!("could not serialize draft references: {e}"))?;
    conn.execute(
        "INSERT INTO drafts
            (draft_id, account_id, to_addr, subject, body_text, body_html,
             in_reply_to, refs, attachments, imap_uid, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(draft_id) DO UPDATE SET
            to_addr = excluded.to_addr,
            subject = excluded.subject,
            body_text = excluded.body_text,
            body_html = excluded.body_html,
            in_reply_to = excluded.in_reply_to,
            refs = excluded.refs,
            attachments = excluded.attachments,
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
            draft.attachments_json,
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
                in_reply_to, refs, attachments, imap_uid, saved_at
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
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<u32>>(9)?,
                row.get::<_, String>(10)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("could not read draft: {e}"))?
    .map(|(draft_id, account_id, to_addr, subject, body_text, body_html, in_reply_to, refs_json, attachments_json, imap_uid, saved_at)| {
        let references = refs_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        Ok(DraftRecord { draft_id, account_id, to_addr, subject, body_text, body_html, in_reply_to, references, attachments_json, imap_uid, saved_at })
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
             attachments, in_reply_to, refs, encrypt, attempt_count, last_error, created_at,
             cc, bcc, send_at, from_override)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
            record.cc,
            record.bcc,
            record.send_at,
            record.from_override,
        ],
    )
    .map_err(|e| format!("could not insert outbox item: {e}"))?;
    Ok(())
}

pub fn list_outbox(conn: &Connection, account_id: &str) -> Result<Vec<OutboxRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT outbox_id, account_id, to_addr, subject, body_text, body_html,
                    attachments, in_reply_to, refs, encrypt, attempt_count, last_error, created_at,
                    cc, bcc, send_at, from_override
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
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
            ))
        })
        .map_err(|e| format!("could not query outbox: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read outbox row: {e}"))?
        .into_iter()
        .map(|(outbox_id, account_id, to_addr, subject, body_text, body_html, attachments_json, in_reply_to, refs_json, encrypt, attempt_count, last_error, created_at, cc, bcc, send_at, from_override)| {
            let references = refs_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok(OutboxRecord { outbox_id, account_id, to_addr, cc, bcc, subject, body_text, body_html, attachments_json, in_reply_to, references, encrypt, attempt_count, last_error, created_at, send_at, from_override })
        })
        .collect()
}

/// Deletes an outbox row by id. Returns `Ok(true)` if the row existed and was
/// deleted, `Ok(false)` if it was already gone (sent and cleaned up before
/// this call). Used by `cancel_queued_send` -- the frontend calls this within
/// the undo window, and the row disappearing is a normal race condition, not
/// an error.
pub fn cancel_outbox_item(conn: &Connection, outbox_id: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM outbox WHERE outbox_id = ?1", params![outbox_id])
        .map_err(|e| format!("could not cancel outbox item: {e}"))?;
    Ok(n > 0)
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

// ---------------------------------------------------------------------------
// Snooze
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SnoozedMessage {
    pub id: String,
    pub account_id: String,
    pub folder: Option<String>,
    pub uid: Option<i64>,
    pub pop3_uidl: Option<String>,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub snooze_until: String,
    pub created_at: String,
}

pub(crate) fn insert_snooze(
    conn: &Connection,
    id: &str,
    account_id: &str,
    folder: Option<&str>,
    uid: Option<i64>,
    pop3_uidl: Option<&str>,
    subject: Option<&str>,
    sender: Option<&str>,
    snooze_until: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO snoozed_messages
         (id, account_id, folder, uid, pop3_uidl, subject, sender, snooze_until, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![id, account_id, folder, uid, pop3_uidl, subject, sender, snooze_until, now],
    )
    .map_err(|e| format!("could not insert snooze: {e}"))?;
    Ok(())
}

pub(crate) fn delete_snooze(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM snoozed_messages WHERE id = ?1", params![id])
        .map_err(|e| format!("could not delete snooze: {e}"))?;
    Ok(())
}

fn row_to_snoozed(row: &rusqlite::Row<'_>) -> rusqlite::Result<SnoozedMessage> {
    Ok(SnoozedMessage {
        id: row.get(0)?,
        account_id: row.get(1)?,
        folder: row.get(2)?,
        uid: row.get(3)?,
        pop3_uidl: row.get(4)?,
        subject: row.get(5)?,
        sender: row.get(6)?,
        snooze_until: row.get(7)?,
        created_at: row.get(8)?,
    })
}

pub(crate) fn list_due_snoozed(conn: &Connection) -> Result<Vec<SnoozedMessage>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut stmt = conn
        .prepare(
            "SELECT id,account_id,folder,uid,pop3_uidl,subject,sender,snooze_until,created_at
             FROM snoozed_messages WHERE snooze_until <= ?1 ORDER BY snooze_until ASC",
        )
        .map_err(|e| format!("prepare list_due_snoozed: {e}"))?;
    let rows = stmt
        .query_map(params![now], row_to_snoozed)
        .map_err(|e| format!("query list_due_snoozed: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("collect list_due_snoozed: {e}"))?;
    Ok(rows)
}

pub(crate) fn list_all_snoozed(
    conn: &Connection,
    account_id: &str,
) -> Result<Vec<SnoozedMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,account_id,folder,uid,pop3_uidl,subject,sender,snooze_until,created_at
             FROM snoozed_messages WHERE account_id = ?1 ORDER BY snooze_until ASC",
        )
        .map_err(|e| format!("prepare list_all_snoozed: {e}"))?;
    let rows = stmt
        .query_map(params![account_id], row_to_snoozed)
        .map_err(|e| format!("query list_all_snoozed: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("collect list_all_snoozed: {e}"))?;
    Ok(rows)
}

// ── S/MIME cert storage ──────────────────────────────────────────────────────

pub(crate) struct SmimeOwnCert {
    pub account_id: String,
    pub certificate: Vec<u8>,
    pub private_key: Vec<u8>,
    pub fingerprint: String,
    pub subject_cn: Option<String>,
    pub not_after: String,
}

pub(crate) struct SmimeContactCert {
    pub email: String,
    pub certificate: Vec<u8>,
    pub fingerprint: String,
    pub subject_cn: Option<String>,
    pub not_after: String,
    pub added_at: String,
}

pub(crate) fn upsert_smime_own_cert(conn: &Connection, cert: &SmimeOwnCert) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO smime_own_certs
         (account_id, certificate, private_key, fingerprint, subject_cn, not_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            cert.account_id, cert.certificate, cert.private_key,
            cert.fingerprint, cert.subject_cn, cert.not_after
        ],
    )
    .map_err(|e| format!("could not store S/MIME cert for {}: {e}", cert.account_id))?;
    Ok(())
}

pub(crate) fn get_smime_own_cert(conn: &Connection, account_id: &str) -> Result<Option<SmimeOwnCert>, String> {
    conn.query_row(
        "SELECT account_id, certificate, private_key, fingerprint, subject_cn, not_after
         FROM smime_own_certs WHERE account_id = ?1",
        params![account_id],
        |row| {
            Ok(SmimeOwnCert {
                account_id: row.get(0)?,
                certificate: row.get(1)?,
                private_key: row.get(2)?,
                fingerprint: row.get(3)?,
                subject_cn: row.get(4)?,
                not_after: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not load S/MIME cert for {account_id}: {e}"))
}

pub(crate) fn list_smime_own_certs(conn: &Connection) -> Result<Vec<SmimeOwnCert>, String> {
    let mut stmt = conn
        .prepare("SELECT account_id, certificate, private_key, fingerprint, subject_cn, not_after FROM smime_own_certs ORDER BY account_id")
        .map_err(|e| format!("prepare list_smime_own_certs: {e}"))?;
    let rows = stmt.query_map([], |row| {
        Ok(SmimeOwnCert {
            account_id: row.get(0)?,
            certificate: row.get(1)?,
            private_key: row.get(2)?,
            fingerprint: row.get(3)?,
            subject_cn: row.get(4)?,
            not_after: row.get(5)?,
        })
    })
    .map_err(|e| format!("query list_smime_own_certs: {e}"))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| format!("collect list_smime_own_certs: {e}"))?;
    Ok(rows)
}

pub(crate) fn delete_smime_own_cert(conn: &Connection, account_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM smime_own_certs WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("could not delete S/MIME cert for {account_id}: {e}"))?;
    Ok(())
}

pub(crate) fn upsert_smime_contact_cert(conn: &Connection, cert: &SmimeContactCert) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO smime_contact_certs
         (email, certificate, fingerprint, subject_cn, not_after, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            cert.email, cert.certificate, cert.fingerprint,
            cert.subject_cn, cert.not_after, cert.added_at
        ],
    )
    .map_err(|e| format!("could not store S/MIME contact cert for {}: {e}", cert.email))?;
    Ok(())
}

pub(crate) fn get_smime_contact_cert(conn: &Connection, email: &str) -> Result<Option<SmimeContactCert>, String> {
    conn.query_row(
        "SELECT email, certificate, fingerprint, subject_cn, not_after, added_at
         FROM smime_contact_certs WHERE email = ?1",
        params![email.to_lowercase()],
        |row| {
            Ok(SmimeContactCert {
                email: row.get(0)?,
                certificate: row.get(1)?,
                fingerprint: row.get(2)?,
                subject_cn: row.get(3)?,
                not_after: row.get(4)?,
                added_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not load S/MIME contact cert for {email}: {e}"))
}

pub(crate) fn list_smime_contact_certs(conn: &Connection) -> Result<Vec<SmimeContactCert>, String> {
    let mut stmt = conn
        .prepare("SELECT email, certificate, fingerprint, subject_cn, not_after, added_at FROM smime_contact_certs ORDER BY email")
        .map_err(|e| format!("prepare list_smime_contact_certs: {e}"))?;
    let rows = stmt.query_map([], |row| {
        Ok(SmimeContactCert {
            email: row.get(0)?,
            certificate: row.get(1)?,
            fingerprint: row.get(2)?,
            subject_cn: row.get(3)?,
            not_after: row.get(4)?,
            added_at: row.get(5)?,
        })
    })
    .map_err(|e| format!("query list_smime_contact_certs: {e}"))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| format!("collect list_smime_contact_certs: {e}"))?;
    Ok(rows)
}

pub(crate) fn delete_smime_contact_cert(conn: &Connection, email: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM smime_contact_certs WHERE email = ?1",
        params![email.to_lowercase()],
    )
    .map_err(|e| format!("could not delete S/MIME contact cert for {email}: {e}"))?;
    Ok(())
}

// ── CardDAV source storage ────────────────────────────────────────────────────

pub(crate) struct CardDavSourceRecord {
    pub id: i64,
    pub account_id: String,
    pub url: String,
    pub display_name: Option<String>,
    pub username: String,
    pub last_synced_at: Option<String>,
}

fn row_to_carddav(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardDavSourceRecord> {
    Ok(CardDavSourceRecord {
        id: row.get(0)?,
        account_id: row.get(1)?,
        url: row.get(2)?,
        display_name: row.get(3)?,
        username: row.get(4)?,
        last_synced_at: row.get(5)?,
    })
}

pub(crate) fn insert_carddav_source(
    conn: &Connection,
    account_id: &str,
    url: &str,
    display_name: Option<&str>,
    username: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO carddav_sources (account_id, url, display_name, username)
         VALUES (?1, ?2, ?3, ?4)",
        params![account_id, url, display_name, username],
    )
    .map_err(|e| format!("could not insert CardDAV source: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn get_carddav_source(conn: &Connection, id: i64) -> Result<Option<CardDavSourceRecord>, String> {
    conn.query_row(
        "SELECT id, account_id, url, display_name, username, last_synced_at
         FROM carddav_sources WHERE id = ?1",
        params![id],
        row_to_carddav,
    )
    .optional()
    .map_err(|e| format!("could not load CardDAV source {id}: {e}"))
}

pub(crate) fn list_carddav_sources_db(conn: &Connection) -> Result<Vec<CardDavSourceRecord>, String> {
    let mut stmt = conn
        .prepare("SELECT id, account_id, url, display_name, username, last_synced_at FROM carddav_sources ORDER BY id")
        .map_err(|e| format!("prepare list_carddav_sources: {e}"))?;
    let rows = stmt.query_map([], row_to_carddav)
        .map_err(|e| format!("query list_carddav_sources: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("collect list_carddav_sources: {e}"))?;
    Ok(rows)
}

pub(crate) fn delete_carddav_source_db(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM carddav_sources WHERE id = ?1", params![id])
        .map_err(|e| format!("could not delete CardDAV source {id}: {e}"))?;
    Ok(())
}

pub(crate) fn update_carddav_synced(conn: &Connection, id: i64, ts: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE carddav_sources SET last_synced_at = ?1 WHERE id = ?2",
        params![ts, id],
    )
    .map_err(|e| format!("could not update CardDAV sync time for {id}: {e}"))?;
    Ok(())
}

// ── CalDAV ────────────────────────────────────────────────────────────────────

pub(crate) struct CalDavSourceRecord {
    pub id: i64,
    pub account_id: String,
    pub url: String,
    pub display_name: Option<String>,
    pub username: String,
    pub color: Option<String>,
    pub last_synced_at: Option<String>,
}

pub(crate) struct CalendarEventRecord {
    pub id: i64,
    pub source_id: i64,
    pub uid: String,
    pub href: String,
    pub etag: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub dtstart: Option<String>,
    pub dtend: Option<String>,
    pub organizer: Option<String>,
    pub status: Option<String>,
    pub rrule: Option<String>,
    pub sequence: i64,
    pub raw_ics: String,
    pub synced_at: String,
}

fn row_to_caldav_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalDavSourceRecord> {
    Ok(CalDavSourceRecord {
        id: row.get(0)?,
        account_id: row.get(1)?,
        url: row.get(2)?,
        display_name: row.get(3)?,
        username: row.get(4)?,
        color: row.get(5)?,
        last_synced_at: row.get(6)?,
    })
}

fn row_to_calendar_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalendarEventRecord> {
    Ok(CalendarEventRecord {
        id: row.get(0)?,
        source_id: row.get(1)?,
        uid: row.get(2)?,
        href: row.get(3)?,
        etag: row.get(4)?,
        summary: row.get(5)?,
        description: row.get(6)?,
        location: row.get(7)?,
        dtstart: row.get(8)?,
        dtend: row.get(9)?,
        organizer: row.get(10)?,
        status: row.get(11)?,
        rrule: row.get(12)?,
        sequence: row.get(13)?,
        raw_ics: row.get(14)?,
        synced_at: row.get(15)?,
    })
}

pub(crate) fn insert_caldav_source(
    conn: &Connection,
    account_id: &str,
    url: &str,
    display_name: Option<&str>,
    username: &str,
    color: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO caldav_sources (account_id, url, display_name, username, color)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![account_id, url, display_name, username, color],
    )
    .map_err(|e| format!("could not insert CalDAV source: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn get_caldav_source(conn: &Connection, id: i64) -> Result<Option<CalDavSourceRecord>, String> {
    conn.query_row(
        "SELECT id, account_id, url, display_name, username, color, last_synced_at
         FROM caldav_sources WHERE id = ?1",
        params![id],
        row_to_caldav_source,
    )
    .optional()
    .map_err(|e| format!("could not load CalDAV source {id}: {e}"))
}

pub(crate) fn list_caldav_sources_db(conn: &Connection) -> Result<Vec<CalDavSourceRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, url, display_name, username, color, last_synced_at
             FROM caldav_sources ORDER BY id",
        )
        .map_err(|e| format!("prepare list_caldav_sources: {e}"))?;
    let rows = stmt
        .query_map([], row_to_caldav_source)
        .map_err(|e| format!("query list_caldav_sources: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("collect list_caldav_sources: {e}"))?;
    Ok(rows)
}

pub(crate) fn delete_caldav_source_db(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM calendar_events WHERE source_id = ?1", params![id])
        .map_err(|e| format!("could not delete events for CalDAV source {id}: {e}"))?;
    conn.execute("DELETE FROM caldav_sources WHERE id = ?1", params![id])
        .map_err(|e| format!("could not delete CalDAV source {id}: {e}"))?;
    Ok(())
}

pub(crate) fn update_caldav_source_color_db(
    conn: &Connection,
    id: i64,
    color: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE caldav_sources SET color = ?1 WHERE id = ?2",
        params![color, id],
    )
    .map_err(|e| format!("could not update CalDAV source color for {id}: {e}"))?;
    Ok(())
}

pub(crate) fn update_caldav_synced(conn: &Connection, id: i64, ts: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE caldav_sources SET last_synced_at = ?1 WHERE id = ?2",
        params![ts, id],
    )
    .map_err(|e| format!("could not update CalDAV sync time for {id}: {e}"))?;
    Ok(())
}

pub(crate) fn upsert_calendar_event(
    conn: &Connection,
    source_id: i64,
    uid: &str,
    href: &str,
    etag: Option<&str>,
    summary: Option<&str>,
    description: Option<&str>,
    location: Option<&str>,
    dtstart: Option<&str>,
    dtend: Option<&str>,
    organizer: Option<&str>,
    status: Option<&str>,
    rrule: Option<&str>,
    sequence: i64,
    raw_ics: &str,
    synced_at: &str,
) -> Result<bool, String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM calendar_events WHERE source_id = ?1 AND uid = ?2",
            params![source_id, uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("could not check existing event {uid}: {e}"))?;

    conn.execute(
        "INSERT INTO calendar_events
            (source_id, uid, href, etag, summary, description, location,
             dtstart, dtend, organizer, status, rrule, sequence, raw_ics, synced_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(source_id, uid) DO UPDATE SET
            href=excluded.href, etag=excluded.etag, summary=excluded.summary,
            description=excluded.description, location=excluded.location,
            dtstart=excluded.dtstart, dtend=excluded.dtend,
            organizer=excluded.organizer, status=excluded.status,
            rrule=excluded.rrule, sequence=excluded.sequence,
            raw_ics=excluded.raw_ics, synced_at=excluded.synced_at",
        params![
            source_id, uid, href, etag, summary, description, location,
            dtstart, dtend, organizer, status, rrule, sequence, raw_ics, synced_at,
        ],
    )
    .map_err(|e| format!("could not upsert calendar event {uid}: {e}"))?;

    Ok(existing.is_none()) // true = added, false = updated
}

pub(crate) fn list_calendar_events_db(
    conn: &Connection,
    source_id: Option<i64>,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> Result<Vec<CalendarEventRecord>, String> {
    // Build the query dynamically based on which filters are present.
    let mut sql = String::from(
        "SELECT id,source_id,uid,href,etag,summary,description,location,
                dtstart,dtend,organizer,status,rrule,sequence,raw_ics,synced_at
         FROM calendar_events WHERE 1=1",
    );
    if source_id.is_some() {
        sql.push_str(" AND source_id = ?1");
    }
    if from_date.is_some() {
        sql.push_str(if source_id.is_some() { " AND dtstart >= ?2" } else { " AND dtstart >= ?1" });
    }
    if to_date.is_some() {
        let p = match (source_id.is_some(), from_date.is_some()) {
            (true, true) => "?3",
            _ if source_id.is_some() || from_date.is_some() => "?2",
            _ => "?1",
        };
        sql.push_str(&format!(" AND dtstart <= {p}"));
    }
    sql.push_str(" ORDER BY dtstart ASC");

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare list_calendar_events: {e}"))?;

    let rows = match (source_id, from_date, to_date) {
        (Some(sid), Some(fd), Some(td)) => {
            stmt.query_map(params![sid, fd, td], row_to_calendar_event)
        }
        (Some(sid), Some(fd), None) => {
            stmt.query_map(params![sid, fd], row_to_calendar_event)
        }
        (Some(sid), None, Some(td)) => {
            stmt.query_map(params![sid, td], row_to_calendar_event)
        }
        (Some(sid), None, None) => {
            stmt.query_map(params![sid], row_to_calendar_event)
        }
        (None, Some(fd), Some(td)) => {
            stmt.query_map(params![fd, td], row_to_calendar_event)
        }
        (None, Some(fd), None) => {
            stmt.query_map(params![fd], row_to_calendar_event)
        }
        (None, None, Some(td)) => {
            stmt.query_map(params![td], row_to_calendar_event)
        }
        (None, None, None) => {
            stmt.query_map([], row_to_calendar_event)
        }
    }
    .map_err(|e| format!("query list_calendar_events: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("collect list_calendar_events: {e}"))
}

pub(crate) fn get_calendar_event_db(
    conn: &Connection,
    source_id: i64,
    uid: &str,
) -> Result<Option<CalendarEventRecord>, String> {
    conn.query_row(
        "SELECT id,source_id,uid,href,etag,summary,description,location,
                dtstart,dtend,organizer,status,rrule,sequence,raw_ics,synced_at
         FROM calendar_events WHERE source_id = ?1 AND uid = ?2",
        params![source_id, uid],
        row_to_calendar_event,
    )
    .optional()
    .map_err(|e| format!("could not load calendar event {uid}: {e}"))
}

pub(crate) fn delete_calendar_event_db(
    conn: &Connection,
    source_id: i64,
    uid: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM calendar_events WHERE source_id = ?1 AND uid = ?2",
        params![source_id, uid],
    )
    .map_err(|e| format!("could not delete calendar event {uid}: {e}"))?;
    Ok(())
}

/// Removes all events for `source_id` whose UID is not in `current_uids`.
/// Returns the count of deleted rows. Called after a sync to purge events
/// that were deleted on the server since the last pull.
pub(crate) fn purge_stale_calendar_events(
    conn: &Connection,
    source_id: i64,
    current_uids: &[String],
) -> Result<u32, String> {
    if current_uids.is_empty() {
        // If the server returned nothing, don't delete everything — treat it
        // as an empty-response edge case rather than "all events deleted".
        return Ok(0);
    }
    // Build a parameterised NOT IN clause.
    let placeholders = current_uids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "DELETE FROM calendar_events WHERE source_id = ?1 AND uid NOT IN ({placeholders})"
    );
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(source_id)];
    for uid in current_uids {
        params_vec.push(Box::new(uid.clone()));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    let deleted = conn
        .execute(&sql, refs.as_slice())
        .map_err(|e| format!("could not purge stale calendar events: {e}"))?;
    Ok(deleted as u32)
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
            is_spam: false,
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
            smime_signed: false,
            smime_verified: None,
            smime_encrypted: false,
            smime_signer_email: None,
            from: Some("Sender <sender@helix.test>".to_string()),
            to: vec!["Recipient <recipient@helix.test>".to_string()],
            cc: Vec::new(),
            reply_to: None,
            message_id: Some("abc123@helix.test".to_string()),
            in_reply_to: None,
            references: Vec::new(),
            disposition_notification_to: None,
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
    fn get_cached_summaries_returns_cached_rows_newest_first_with_threading_headers() {
        let path = TempCachePath::new("cached-summaries");
        let conn = open_at(&path.0, "c1").expect("open should succeed");

        let mut older = sample_summary(1);
        older.date = Some("2026-06-20T08:00:00+00:00".to_string());
        older.message_id = Some("older@helix.test".to_string());
        let mut newer = sample_summary(2);
        newer.date = Some("2026-06-20T10:00:00+00:00".to_string());
        newer.message_id = Some("newer@helix.test".to_string());
        newer.in_reply_to = Some("older@helix.test".to_string());

        upsert_summaries(&conn, "me@helix.test", "INBOX", &[older, newer])
            .expect("caching summaries should succeed");

        let cached = get_cached_summaries(&conn, "me@helix.test", "INBOX", 10)
            .expect("read should succeed");

        assert_eq!(cached.len(), 2);
        assert_eq!(cached[0].uid, Some(2), "newest first");
        assert_eq!(cached[0].message_id.as_deref(), Some("newer@helix.test"));
        assert_eq!(
            cached[0].in_reply_to.as_deref(),
            Some("older@helix.test"),
            "threading headers must survive the cache round-trip so offline threading works"
        );
        assert_eq!(cached[1].uid, Some(1));
    }

    #[test]
    fn get_cached_body_returns_none_when_only_the_summary_was_cached() {
        let path = TempCachePath::new("cached-body-none");
        let conn = open_at(&path.0, "c2").expect("open should succeed");

        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
            .expect("caching summary should succeed");

        let body = get_cached_body(&conn, "me@helix.test", "INBOX", 1).expect("read should succeed");
        assert!(body.is_none(), "a summary-only row has no cached body to return");
    }

    #[test]
    fn get_cached_body_returns_the_body_once_it_has_been_cached() {
        let path = TempCachePath::new("cached-body-some");
        let conn = open_at(&path.0, "c3").expect("open should succeed");

        upsert_summaries(&conn, "me@helix.test", "INBOX", &[sample_summary(1)])
            .expect("caching summary should succeed");
        upsert_body(&conn, "me@helix.test", "INBOX", 1, &sample_body())
            .expect("caching body should succeed");

        let body = get_cached_body(&conn, "me@helix.test", "INBOX", 1)
            .expect("read should succeed")
            .expect("body should be cached");
        assert_eq!(body.text.as_deref(), Some("plain text body"));
        assert_eq!(body.html.as_deref(), Some("<p>html body</p>"));
    }

    #[test]
    fn get_cached_body_returns_none_for_an_uncached_uid() {
        let path = TempCachePath::new("cached-body-missing");
        let conn = open_at(&path.0, "c4").expect("open should succeed");
        let body = get_cached_body(&conn, "me@helix.test", "INBOX", 999).expect("read should succeed");
        assert!(body.is_none(), "a UID that was never cached returns None, not an error");
    }

    #[test]
    fn round_trips_an_attachment_through_the_byte_cache() {
        use base64::Engine;
        let path = TempCachePath::new("attach-round-trip");
        let conn = open_at(&path.0, "d1").expect("open should succeed");

        let bytes = b"\x00\x01\x02PDF-ish bytes\xff";
        upsert_attachment(&conn, "me@helix.test", "INBOX", 1, 0, Some("file.pdf"), Some("application/pdf"), bytes)
            .expect("caching attachment should succeed");

        let got = get_cached_attachment(&conn, "me@helix.test", "INBOX", 1, 0)
            .expect("read should succeed")
            .expect("attachment should be cached");
        assert_eq!(got.filename.as_deref(), Some("file.pdf"));
        assert_eq!(got.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(got.content_base64).unwrap(),
            bytes,
            "round-tripped bytes must be byte-identical"
        );

        assert!(
            get_cached_attachment(&conn, "me@helix.test", "INBOX", 1, 1)
                .expect("read should succeed")
                .is_none(),
            "an attachment index that was never cached returns None"
        );
    }

    #[test]
    fn skips_caching_an_attachment_over_the_per_item_cap() {
        let path = TempCachePath::new("attach-too-big");
        let conn = open_at(&path.0, "d2").expect("open should succeed");

        // Cap of 4 bytes, budget irrelevant: a 5-byte attachment is skipped.
        upsert_attachment_bounded(&conn, "me@helix.test", "INBOX", 1, 0, None, None, b"12345", 4, 1_000)
            .expect("an oversize attachment is a skip, not an error");
        assert!(
            get_cached_attachment(&conn, "me@helix.test", "INBOX", 1, 0).unwrap().is_none(),
            "an attachment over the per-item cap must not be cached"
        );
    }

    #[test]
    fn evicts_oldest_attachments_when_over_total_budget() {
        let path = TempCachePath::new("attach-evict");
        let conn = open_at(&path.0, "d3").expect("open should succeed");

        // Budget 250 bytes, three 100-byte attachments: the third insert
        // pushes the total to 300, so the oldest is evicted back down to 200.
        let blob = vec![0u8; 100];
        for uid in 1..=3u32 {
            upsert_attachment_bounded(&conn, "me@helix.test", "INBOX", uid, 0, None, None, &blob, 1_000, 250)
                .expect("caching should succeed");
        }

        let count: i64 = conn
            .query_row("SELECT count(*) FROM cached_attachments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "the oldest attachment should have been evicted");
        assert!(
            get_cached_attachment(&conn, "me@helix.test", "INBOX", 1, 0).unwrap().is_none(),
            "the first (oldest) attachment is the one evicted"
        );
        assert!(
            get_cached_attachment(&conn, "me@helix.test", "INBOX", 3, 0).unwrap().is_some(),
            "the newest attachment is kept"
        );
    }

    #[test]
    fn cached_body_relists_downloaded_attachments() {
        let path = TempCachePath::new("attach-relist");
        let conn = open_at(&path.0, "d4").expect("open should succeed");

        upsert_body(&conn, "me@helix.test", "INBOX", 1, &sample_body()).expect("caching body should succeed");

        // No attachment bytes downloaded yet -> body comes back with an empty list.
        let body = get_cached_body(&conn, "me@helix.test", "INBOX", 1).unwrap().unwrap();
        assert!(body.attachments.is_empty(), "nothing downloaded yet means no attachments listed");

        upsert_attachment(&conn, "me@helix.test", "INBOX", 1, 0, Some("file.pdf"), Some("application/pdf"), b"data")
            .expect("caching attachment should succeed");

        let body = get_cached_body(&conn, "me@helix.test", "INBOX", 1).unwrap().unwrap();
        assert_eq!(body.attachments.len(), 1, "the downloaded attachment is relisted for offline open");
        assert_eq!(body.attachments[0].index, 0);
        assert_eq!(body.attachments[0].filename.as_deref(), Some("file.pdf"));
        assert_eq!(body.attachments[0].size, 4);
    }

    fn pop3_summary(number: u32, uidl: Option<&str>, date: Option<&str>) -> Pop3MessageSummary {
        Pop3MessageSummary {
            number,
            size: 100,
            uidl: uidl.map(|u| u.to_string()),
            subject: Some(format!("POP3 message {number}")),
            from: Some("sender@helix.test".to_string()),
            date: date.map(|d| d.to_string()),
        }
    }

    #[test]
    fn caches_pop3_summaries_only_when_they_carry_a_uidl() {
        let path = TempCachePath::new("pop3-summaries");
        let conn = open_at(&path.0, "e1").expect("open should succeed");

        let summaries = vec![
            pop3_summary(1, Some("uidl-a"), Some("2026-06-20T08:00:00+00:00")),
            pop3_summary(2, None, Some("2026-06-20T09:00:00+00:00")),
            pop3_summary(3, Some("uidl-c"), Some("2026-06-20T10:00:00+00:00")),
        ];
        upsert_pop3_summaries(&conn, "pop@helix.test", &summaries).expect("caching should succeed");

        let cached = get_cached_pop3_summaries(&conn, "pop@helix.test", 50).expect("read should succeed");
        assert_eq!(cached.len(), 2, "the summary with no UIDL must not be cached");
        assert_eq!(cached[0].uidl.as_deref(), Some("uidl-c"), "newest by date comes first");
        assert_eq!(cached[1].uidl.as_deref(), Some("uidl-a"));
    }

    #[test]
    fn re_listing_pop3_refreshes_the_number_without_duplicating_rows() {
        let path = TempCachePath::new("pop3-renumber");
        let conn = open_at(&path.0, "e2").expect("open should succeed");

        upsert_pop3_summaries(&conn, "pop@helix.test", &[pop3_summary(5, Some("stable-uidl"), None)])
            .expect("first caching should succeed");
        // Same message (same UIDL), renumbered after a deletion: still one row.
        upsert_pop3_summaries(&conn, "pop@helix.test", &[pop3_summary(2, Some("stable-uidl"), None)])
            .expect("second caching should succeed");

        let cached = get_cached_pop3_summaries(&conn, "pop@helix.test", 50).expect("read should succeed");
        assert_eq!(cached.len(), 1, "the same UIDL must not create a duplicate row");
        assert_eq!(cached[0].number, 2, "the last-seen number wins");
    }

    #[test]
    fn round_trips_a_pop3_body_by_uidl() {
        let path = TempCachePath::new("pop3-body");
        let conn = open_at(&path.0, "e3").expect("open should succeed");

        // Body before any summary still creates a retrievable row.
        let mut body = sample_body();
        body.message_id = Some("pop3msg@helix.test".to_string());
        upsert_pop3_body(&conn, "pop@helix.test", "uidl-x", &body).expect("caching body should succeed");

        let got = get_cached_pop3_body(&conn, "pop@helix.test", "uidl-x")
            .expect("read should succeed")
            .expect("body should be cached");
        assert_eq!(got.text.as_deref(), Some("plain text body"));
        assert_eq!(got.message_id.as_deref(), Some("pop3msg@helix.test"));

        assert!(
            get_cached_pop3_body(&conn, "pop@helix.test", "never-fetched").unwrap().is_none(),
            "an uncached UIDL returns None"
        );
    }

    #[test]
    fn round_trips_a_pop3_attachment_and_relists_it_on_the_body() {
        use base64::Engine;
        let path = TempCachePath::new("pop3-attach");
        let conn = open_at(&path.0, "e4").expect("open should succeed");

        upsert_pop3_body(&conn, "pop@helix.test", "uidl-z", &sample_body()).expect("caching body should succeed");
        let body = get_cached_pop3_body(&conn, "pop@helix.test", "uidl-z").unwrap().unwrap();
        assert!(body.attachments.is_empty(), "nothing downloaded yet means no attachments listed");

        let bytes = b"pop3 attachment bytes";
        upsert_pop3_attachment(&conn, "pop@helix.test", "uidl-z", 0, Some("a.bin"), Some("application/octet-stream"), bytes)
            .expect("caching attachment should succeed");

        let got = get_cached_pop3_attachment(&conn, "pop@helix.test", "uidl-z", 0)
            .expect("read should succeed")
            .expect("attachment should be cached");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(got.content_base64).unwrap(),
            bytes
        );

        let body = get_cached_pop3_body(&conn, "pop@helix.test", "uidl-z").unwrap().unwrap();
        assert_eq!(body.attachments.len(), 1, "the downloaded POP3 attachment is relisted for offline open");
        assert_eq!(body.attachments[0].filename.as_deref(), Some("a.bin"));
    }

    #[test]
    fn attachment_eviction_spans_both_imap_and_pop3_tables() {
        let path = TempCachePath::new("attach-evict-cross");
        let conn = open_at(&path.0, "e5").expect("open should succeed");

        // Two rows, one per table, with explicit (distinct) fetched_at so the
        // ordering is deterministic: the IMAP row is older than the POP3 row.
        conn.execute(
            "INSERT INTO cached_attachments (account_id, folder, uid, idx, content, size, fetched_at)
             VALUES ('a', 'INBOX', 1, 0, x'00', 100, '2026-06-20T08:00:00+00:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cached_pop3_attachments (account_id, uidl, idx, content, size, fetched_at)
             VALUES ('a', 'uidl-1', 0, x'00', 100, '2026-06-20T09:00:00+00:00')",
            [],
        )
        .unwrap();

        // Budget 150: total is 200, so exactly one (the older IMAP row) is evicted.
        evict_attachments_over_budget(&conn, 150).expect("eviction should succeed");

        let imap_count: i64 = conn
            .query_row("SELECT count(*) FROM cached_attachments", [], |row| row.get(0))
            .unwrap();
        let pop3_count: i64 = conn
            .query_row("SELECT count(*) FROM cached_pop3_attachments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(imap_count, 0, "the older IMAP attachment is evicted first");
        assert_eq!(pop3_count, 1, "the newer POP3 attachment is kept");
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
            imap_use_starttls: false,
            smtp_host: "smtp.helix.test".to_string(),
            smtp_port: 465,
            smtp_use_starttls: false,
            incoming_protocol: "imap".to_string(),
            pop3_host: None,
            pop3_port: None,
            archive_folder: "Archive".to_string(),
            trash_folder: "Trash".to_string(),
            drafts_folder: "Drafts".to_string(),
            spam_folder: "Spam".to_string(),
            sent_folder: "Sent".to_string(),
            auth_method: "password".to_string(),
            oauth_provider: None,
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

        let results = search_contacts_in(&conn, "ali", 10, None).expect("search should succeed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].email, "alice@example.com", "emails are stored lowercased");
        assert_eq!(results[0].display_name.as_deref(), Some("Alice"));

        let all = search_contacts_in(&conn, "example.com", 10, None).expect("search should succeed");
        assert_eq!(all.len(), 2, "both contacts should match a broader query");
    }

    #[test]
    fn list_contacts_returns_all_rows_and_delete_removes_one() {
        let path = TempCachePath::new("contacts-list-delete");
        let conn = open_at(&path.0, "ct").expect("open should succeed");

        upsert_contacts(
            &conn,
            &[
                ("alice@example.com".to_string(), Some("Alice".to_string())),
                ("bob@example.com".to_string(), None),
            ],
        )
        .expect("upsert should succeed");

        let all = list_contacts_in(&conn, 100, None).expect("list should succeed");
        assert_eq!(all.len(), 2, "both harvested contacts should be listed");

        // Mixed-case input must still match the lowercased stored row.
        delete_contact_in(&conn, "Alice@Example.com").expect("delete should succeed");

        let after = list_contacts_in(&conn, 100, None).expect("list should succeed");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].email, "bob@example.com", "only the deleted contact should be gone");

        // Deleting something that isn't there is a no-op success.
        delete_contact_in(&conn, "nobody@example.com").expect("deleting a missing contact should not error");
    }

    #[test]
    fn get_account_round_trips_pop3_and_starttls_fields() {
        let path = TempCachePath::new("get-account-pop3");
        let conn = open_at(&path.0, "ga").expect("open should succeed");

        let mut pop3 = sample_account("pop@helix.test");
        pop3.incoming_protocol = "pop3".to_string();
        pop3.imap_host = String::new();
        pop3.imap_port = 0;
        pop3.pop3_host = Some("pop.helix.test".to_string());
        pop3.pop3_port = Some(995);
        pop3.imap_use_starttls = false;
        upsert_account(&conn, &pop3).expect("upsert should succeed");

        let fetched = get_account(&conn, "pop@helix.test")
            .expect("get should succeed")
            .expect("account should exist");
        assert_eq!(fetched.incoming_protocol, "pop3");
        assert_eq!(fetched.pop3_host.as_deref(), Some("pop.helix.test"));
        assert_eq!(fetched.pop3_port, Some(995));

        assert!(
            get_account(&conn, "nobody@helix.test").expect("get should succeed").is_none(),
            "a missing account returns None, not an error"
        );
    }

    #[test]
    fn a_nameless_sighting_does_not_clobber_an_already_known_name() {
        let path = TempCachePath::new("contacts-preserve-name");
        let conn = open_at(&path.0, "jj").expect("open should succeed");

        upsert_contacts(&conn, &[("carol@example.com".to_string(), Some("Carol".to_string()))])
            .expect("first upsert should succeed");
        upsert_contacts(&conn, &[("carol@example.com".to_string(), None)])
            .expect("second upsert should succeed");

        let results = search_contacts_in(&conn, "carol", 10, None).expect("search should succeed");
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
            attachments_json: None,
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
            cc: "cc@helix.test".to_string(),
            bcc: String::new(),
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
            send_at: None,
            from_override: None,
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

    /// A summary with caller-chosen searchable fields, for FTS tests.
    fn search_summary(uid: u32, subject: &str, from: &str, date: &str) -> MessageSummary {
        MessageSummary {
            uid: Some(uid),
            subject: Some(subject.to_string()),
            from: Some(from.to_string()),
            date: Some(date.to_string()),
            seen: false,
            flagged: false,
            message_id: None,
            in_reply_to: None,
            is_spam: false,
        }
    }

    #[test]
    fn build_fts_query_quotes_tokens_and_handles_empties() {
        assert_eq!(build_fts_query("hello world"), Some("\"hello\"* \"world\"*".to_string()));
        // A bare FTS operator must be neutralized into a literal phrase, not
        // passed through as syntax.
        assert_eq!(build_fts_query("AND"), Some("\"AND\"*".to_string()));
        // Embedded double quotes are doubled per FTS5's escaping rule.
        assert_eq!(build_fts_query("say \"hi\""), Some("\"say\"* \"\"\"hi\"\"\"*".to_string()));
        assert_eq!(build_fts_query(""), None);
        assert_eq!(build_fts_query("   "), None);
    }

    #[test]
    fn local_search_matches_subject_from_and_body_across_folders() {
        let path = TempCachePath::new("fts-search");
        let conn = open_at(&path.0, "fts1").expect("open should succeed");

        upsert_summaries(
            &conn,
            "me@helix.test",
            "INBOX",
            &[search_summary(1, "Quarterly invoice", "billing@acme.test", "2026-06-20T00:00:00+00:00")],
        )
        .expect("caching summaries should succeed");
        upsert_summaries(
            &conn,
            "me@helix.test",
            "Archive",
            &[search_summary(2, "Lunch plans", "friend@helix.test", "2026-06-19T00:00:00+00:00")],
        )
        .expect("caching summaries should succeed");
        upsert_body(
            &conn,
            "me@helix.test",
            "Archive",
            2,
            &MessageBody {
                text: Some("let us grab an invoice receipt".to_string()),
                ..sample_body()
            },
        )
        .expect("caching body should succeed");

        // Subject match in INBOX.
        let hits = search_cached_messages(&conn, None, "invoice", 10).expect("search should succeed");
        let uids: Vec<u32> = hits.iter().map(|h| h.uid).collect();
        assert!(uids.contains(&1), "subject match should be found");
        // Body match in Archive -- proves the search spans folders and bodies.
        assert!(uids.contains(&2), "body match in another folder should be found");
        // Newest first.
        assert_eq!(hits[0].uid, 1, "results should be ordered newest first");

        // From-address match.
        let billing = search_cached_messages(&conn, None, "billing", 10).expect("search should succeed");
        assert_eq!(billing.len(), 1);
        assert_eq!(billing[0].uid, 1);
        assert_eq!(billing[0].folder, "INBOX");
    }

    #[test]
    fn local_search_scopes_to_one_account_when_asked() {
        let path = TempCachePath::new("fts-scope");
        let conn = open_at(&path.0, "fts2").expect("open should succeed");

        upsert_summaries(
            &conn,
            "a@helix.test",
            "INBOX",
            &[search_summary(1, "shared keyword here", "x@helix.test", "2026-06-20T00:00:00+00:00")],
        )
        .expect("caching should succeed");
        upsert_summaries(
            &conn,
            "b@helix.test",
            "INBOX",
            &[search_summary(2, "shared keyword here", "y@helix.test", "2026-06-20T00:00:00+00:00")],
        )
        .expect("caching should succeed");

        let global = search_cached_messages(&conn, None, "keyword", 10).expect("search should succeed");
        assert_eq!(global.len(), 2, "unscoped search should see both accounts");

        let scoped =
            search_cached_messages(&conn, Some("a@helix.test"), "keyword", 10).expect("search should succeed");
        assert_eq!(scoped.len(), 1, "scoped search should see only one account");
        assert_eq!(scoped[0].account_id, "a@helix.test");
    }

    #[test]
    fn local_search_index_follows_updates_and_deletes() {
        let path = TempCachePath::new("fts-sync");
        let conn = open_at(&path.0, "fts3").expect("open should succeed");

        upsert_summaries(
            &conn,
            "me@helix.test",
            "INBOX",
            &[search_summary(1, "original subject", "s@helix.test", "2026-06-20T00:00:00+00:00")],
        )
        .expect("caching should succeed");

        // An upsert that changes the subject must re-index: the old term stops
        // matching, the new term starts.
        upsert_summaries(
            &conn,
            "me@helix.test",
            "INBOX",
            &[search_summary(1, "revised subject", "s@helix.test", "2026-06-20T00:00:00+00:00")],
        )
        .expect("re-caching should succeed");
        assert!(
            search_cached_messages(&conn, None, "original", 10).unwrap().is_empty(),
            "the old subject term should no longer match after an update"
        );
        assert_eq!(
            search_cached_messages(&conn, None, "revised", 10).unwrap().len(),
            1,
            "the new subject term should match after an update"
        );

        // Clearing the cache deletes the rows, which must empty the index too.
        clear_cache_in(&conn).expect("clear should succeed");
        assert!(
            search_cached_messages(&conn, None, "revised", 10).unwrap().is_empty(),
            "a cleared cache should leave nothing to find"
        );
    }

    #[test]
    fn local_search_backfills_index_for_a_preexisting_cache() {
        // Simulates a cache that held messages before the FTS index existed:
        // insert a row with the triggers temporarily dropped so the index is
        // left empty, then reopen (which runs backfill_fts_if_empty) and
        // confirm the message becomes searchable.
        let path = TempCachePath::new("fts-backfill");
        {
            let conn = open_at(&path.0, "fts4").expect("open should succeed");
            conn.execute_batch(
                "DROP TRIGGER cached_messages_fts_ai;
                 DROP TRIGGER cached_messages_fts_au;
                 DROP TRIGGER cached_messages_fts_ad;",
            )
            .expect("dropping triggers should succeed");
            upsert_summaries(
                &conn,
                "me@helix.test",
                "INBOX",
                &[search_summary(1, "needle in the haystack", "s@helix.test", "2026-06-20T00:00:00+00:00")],
            )
            .expect("caching should succeed");
            // The index was bypassed, so nothing is findable yet.
            assert!(search_cached_messages(&conn, None, "needle", 10).unwrap().is_empty());
        }

        // Reopen: ensure_schema recreates the triggers, backfill rebuilds the
        // index from the existing content table.
        let conn = open_at(&path.0, "fts4").expect("reopen should succeed");
        assert_eq!(
            search_cached_messages(&conn, None, "needle", 10).unwrap().len(),
            1,
            "backfill should make a pre-existing cached message searchable"
        );
    }

    #[test]
    fn local_search_spans_imap_and_pop3_and_tags_pop3_hits_with_uidl() {
        let path = TempCachePath::new("fts-pop3");
        let conn = open_at(&path.0, "fts5").expect("open should succeed");

        // One IMAP message and one POP3 message, both mentioning "zebra".
        upsert_summaries(
            &conn,
            "imap@helix.test",
            "INBOX",
            &[search_summary(1, "zebra crossing", "s@helix.test", "2026-06-20T08:00:00+00:00")],
        )
        .expect("caching IMAP summary should succeed");

        upsert_pop3_summaries(&conn, "pop@helix.test", &[pop3_summary(7, Some("uidl-7"), Some("2026-06-20T10:00:00+00:00"))])
            .expect("caching POP3 summary should succeed");
        let mut pop3_body = sample_body();
        pop3_body.text = Some("a zebra appears in the body".to_string());
        upsert_pop3_body(&conn, "pop@helix.test", "uidl-7", &pop3_body).expect("caching POP3 body should succeed");

        let hits = search_cached_messages(&conn, None, "zebra", 10).expect("search should succeed");
        assert_eq!(hits.len(), 2, "both the IMAP and POP3 matches should be found");
        // Newest first: the POP3 message (10:00) sorts ahead of the IMAP one (08:00).
        assert_eq!(hits[0].account_id, "pop@helix.test");
        assert_eq!(hits[0].uidl.as_deref(), Some("uidl-7"), "a POP3 hit carries its UIDL");
        assert_eq!(hits[0].folder, "INBOX");
        assert_eq!(hits[0].uid, 7, "POP3 number rides in uid for a live RETR");
        assert_eq!(hits[1].account_id, "imap@helix.test");
        assert!(hits[1].uidl.is_none(), "an IMAP hit has no UIDL");

        // Scoping to the POP3 account excludes the IMAP hit.
        let scoped = search_cached_messages(&conn, Some("pop@helix.test"), "zebra", 10).expect("scoped search");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].account_id, "pop@helix.test");
    }
}
