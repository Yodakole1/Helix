//! An in-memory, bounded log of what this app did recently, kept so users
//! and maintainers can see exactly what happened on the last sync/send/
//! notification attempt without digging through OS-level logs -- surfaced
//! read-only in Settings > About, behind the Debug mode toggle. Every
//! subsystem records here through `record(source, message)`: DAV requests
//! (method, URL, HTTP status), IMAP/POP3 connection and login failures,
//! SMTP send outcomes, IDLE push events and reconnects, OAuth token
//! refreshes, account add/remove, and desktop notification delivery.
//! Entries never carry a request body, password, or token -- only hosts,
//! folder names, account emails (already visible in the UI), and outcome
//! text, which is enough to tell a permissions problem (403) apart from a
//! URL typo (404) or a network failure.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_ENTRIES: usize = 500;

#[derive(Clone, Serialize)]
pub struct DebugLogEntry {
    pub timestamp: String,
    pub source: String,
    pub message: String,
}

static LOG: Mutex<VecDeque<DebugLogEntry>> = Mutex::new(VecDeque::new());

pub(crate) fn record(source: &str, message: impl Into<String>) {
    let entry = DebugLogEntry {
        timestamp: chrono::Utc::now().to_rfc3339(),
        source: source.to_string(),
        message: message.into(),
    };
    let mut log = LOG.lock().unwrap();
    if log.len() >= MAX_ENTRIES {
        log.pop_front();
    }
    log.push_back(entry);
}

#[tauri::command]
pub async fn get_debug_log() -> Result<Vec<DebugLogEntry>, String> {
    Ok(LOG.lock().unwrap().iter().cloned().collect())
}

#[tauri::command]
pub async fn clear_debug_log() -> Result<(), String> {
    LOG.lock().unwrap().clear();
    Ok(())
}
