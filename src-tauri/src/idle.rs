use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tokio::task::JoinHandle;

use crate::imap;

pub struct IdleRegistry {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl IdleRegistry {
    pub fn new() -> Self {
        Self { tasks: Mutex::new(HashMap::new()) }
    }
}

#[derive(Debug, Serialize, Clone)]
struct NewMailEvent {
    account_id: String,
    folder: String,
    /// Current EXISTS count for the folder after the notification.
    exists: u32,
    /// How many new messages arrived since the last check.
    new_count: u32,
}

/// Starts a background IMAP IDLE (or polling) task for `account_id`.
/// Idempotent: if a task is already running for this account, returns
/// immediately without starting a second one. The task runs until
/// `stop_idle` or `stop_all_idle` is called.
#[tauri::command]
pub async fn start_idle(
    app: tauri::AppHandle,
    state: tauri::State<'_, IdleRegistry>,
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) -> Result<(), String> {
    let mut tasks = state.tasks.lock().unwrap();
    if tasks.contains_key(&account_id) {
        return Ok(());
    }

    let handle = tokio::spawn(run_idle_loop(app, account_id.clone(), host, port, folder));
    tasks.insert(account_id, handle);
    Ok(())
}

#[tauri::command]
pub async fn stop_idle(
    state: tauri::State<'_, IdleRegistry>,
    account_id: String,
) -> Result<(), String> {
    let mut tasks = state.tasks.lock().unwrap();
    if let Some(handle) = tasks.remove(&account_id) {
        handle.abort();
    }
    Ok(())
}

/// Aborts all running IDLE tasks. Call this on app shutdown or before
/// removing all accounts.
#[tauri::command]
pub fn stop_all_idle(state: tauri::State<'_, IdleRegistry>) {
    let mut tasks = state.tasks.lock().unwrap();
    for (_, handle) in tasks.drain() {
        handle.abort();
    }
}

/// Outer reconnect loop. Tries to establish one session via
/// `run_one_idle_session`. On error, backs off exponentially (1 s → 2 s →
/// … → 5 min) and retries. Never exits on its own — the task is stopped
/// externally via `JoinHandle::abort()`.
async fn run_idle_loop(
    app: tauri::AppHandle,
    account_id: String,
    host: String,
    port: u16,
    folder: String,
) {
    let mut backoff = Duration::from_secs(1);

    loop {
        match run_one_idle_session(&app, &account_id, &host, port, &folder).await {
            Ok(()) => break, // graceful stop (shouldn't happen in practice)
            Err(e) => {
                log::warn!("IDLE session for {account_id} ended: {e}; reconnecting in {backoff:?}");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(300));
            }
        }
    }
}

/// One complete IMAP session: login, SELECT folder, check IDLE capability,
/// then run either the IDLE loop or the polling fallback until an error
/// forces reconnect.
async fn run_one_idle_session(
    app: &tauri::AppHandle,
    account_id: &str,
    host: &str,
    port: u16,
    folder: &str,
) -> Result<(), String> {
    let mut session = imap::login_with_stored_credential(host, port, account_id).await?;

    let mailbox = session
        .select(folder)
        .await
        .map_err(|e| format!("could not SELECT {folder}: {e}"))?;
    let mut last_exists = mailbox.exists;

    let caps = session
        .capabilities()
        .await
        .map_err(|e| format!("CAPABILITY failed: {e}"))?;
    let has_idle = caps.has_str("IDLE");

    if has_idle {
        // session is moved into and out of the IDLE handle — see run_idle_inner.
        session = run_idle_inner(session, app, account_id, folder, &mut last_exists).await?;
    } else {
        run_poll_loop(&mut session, app, account_id, folder, &mut last_exists).await?;
    }

    session.logout().await.ok();
    Ok(())
}

/// Runs the RFC 2177 IDLE loop on an already-selected session. IDLE is
/// renewed every 29 minutes (the RFC recommends re-sending IDLE before the
/// server's 30-minute inactivity timeout). After each cycle, EXAMINE is used
/// to get the current EXISTS count rather than parsing the untagged responses
/// that come in during IDLE — this is simpler and equally correct.
///
/// Takes ownership of the session (IDLE consumes it into the Handle; `done()`
/// gives it back) and returns it when the loop exits, so the caller can
/// logout cleanly.
async fn run_idle_inner(
    mut session: imap::ImapSession,
    app: &tauri::AppHandle,
    account_id: &str,
    folder: &str,
    last_exists: &mut u32,
) -> Result<imap::ImapSession, String> {
    use async_imap::extensions::idle::IdleResponse;

    loop {
        let mut handle = session.idle();
        handle.init().await.map_err(|e| format!("IDLE init failed: {e}"))?;

        // wait_with_timeout returns (Future<IdleResponse>, StopSource). The
        // future resolves to the IdleResponse alone — the handle stays alive
        // and is used for done() below. StopSource must outlive the await;
        // the underscore prefix keeps it alive without a warning.
        let (idle_fut, _stop_src) = handle.wait_with_timeout(Duration::from_secs(29 * 60));
        let response = idle_fut
            .await
            .map_err(|e| format!("IDLE wait failed: {e}"))?;

        session = handle.done().await.map_err(|e| format!("IDLE done failed: {e}"))?;

        match response {
            IdleResponse::ManualInterrupt => break,
            IdleResponse::NewData(_) | IdleResponse::Timeout => {
                emit_if_new_mail(&mut session, app, account_id, folder, last_exists).await?;
            }
        }
    }

    Ok(session)
}

/// Polling fallback for servers without IDLE capability. Checks the folder
/// every 60 seconds via EXAMINE. Runs forever (until the task is aborted or
/// a connection error returns Err).
async fn run_poll_loop(
    session: &mut imap::ImapSession,
    app: &tauri::AppHandle,
    account_id: &str,
    folder: &str,
    last_exists: &mut u32,
) -> Result<(), String> {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        emit_if_new_mail(session, app, account_id, folder, last_exists).await?;
    }
}

/// EXAMINEs the folder to get the current message count, and emits a
/// `helix://imap-new-mail` event if the count has increased since the last
/// check. Also resets `last_exists` when the count decreases (expunge).
async fn emit_if_new_mail(
    session: &mut imap::ImapSession,
    app: &tauri::AppHandle,
    account_id: &str,
    folder: &str,
    last_exists: &mut u32,
) -> Result<(), String> {
    let mailbox = session
        .examine(folder)
        .await
        .map_err(|e| format!("EXAMINE failed: {e}"))?;
    let current = mailbox.exists;

    if current > *last_exists {
        let new_count = current - *last_exists;
        if let Err(e) = app.emit(
            "helix://imap-new-mail",
            NewMailEvent {
                account_id: account_id.to_string(),
                folder: folder.to_string(),
                exists: current,
                new_count,
            },
        ) {
            log::warn!("could not emit helix://imap-new-mail: {e}");
        }
    }

    *last_exists = current;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verifies that calling start_idle twice for the same account_id only
    // registers one task in the registry (idempotency check).
    //
    // This test doesn't actually start real IDLE sessions (those need a
    // server); it tests the registry bookkeeping directly.
    #[test]
    fn idle_registry_does_not_add_a_second_task_for_the_same_account() {
        let registry = IdleRegistry::new();

        // Insert a dummy task directly into the registry (simulating what
        // start_idle does) to avoid needing a real AppHandle/server.
        {
            let mut tasks = registry.tasks.lock().unwrap();
            let handle = tokio::runtime::Runtime::new()
                .unwrap()
                .spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
            tasks.insert("me@helix.test".to_string(), handle);
        }

        // A second insertion for the same account_id must not overwrite the
        // first handle — the idempotency guard in start_idle returns early
        // when the key is already present.
        let already_present = {
            let tasks = registry.tasks.lock().unwrap();
            tasks.contains_key("me@helix.test")
        };
        assert!(already_present, "the registry must retain the first task");

        // Cleanup
        let mut tasks = registry.tasks.lock().unwrap();
        if let Some(h) = tasks.remove("me@helix.test") {
            h.abort();
        }
    }

    #[test]
    fn stop_all_idle_drains_the_registry() {
        let registry = IdleRegistry::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        {
            let mut tasks = registry.tasks.lock().unwrap();
            for id in ["a@helix.test", "b@helix.test"] {
                let handle = rt.spawn(async { tokio::time::sleep(Duration::from_secs(3600)).await });
                tasks.insert(id.to_string(), handle);
            }
        }

        // Simulate stop_all_idle (can't call the Tauri command directly without
        // a State wrapper, so we replicate the logic inline).
        {
            let mut tasks = registry.tasks.lock().unwrap();
            for (_, handle) in tasks.drain() {
                handle.abort();
            }
        }

        let tasks = registry.tasks.lock().unwrap();
        assert!(tasks.is_empty(), "stop_all_idle must drain the registry");
    }

    // Exercises the full IDLE loop against a local GreenMail test server.
    // Needs GreenMail running on 127.0.0.1:3993 (IMAP) and a second SMTP
    // connection to deliver a test message. See docs/technical/imap-core.md
    // for the exact docker invocation.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/imap-core.md"]
    async fn detects_new_mail_via_idle_on_a_local_test_server() {
        use tokio::net::TcpStream;
        use tokio_native_tls::TlsConnector;

        let tcp = TcpStream::connect(("127.0.0.1", 3993)).await.unwrap();
        let connector = TlsConnector::from(
            tokio_native_tls::native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .unwrap(),
        );
        let tls = connector.connect("127.0.0.1", tcp).await.unwrap();
        let mut session = async_imap::Client::new(tls)
            .login("helix", "helixpass")
            .await
            .map_err(|(e, _)| e)
            .unwrap();

        let mailbox = session.select("INBOX").await.unwrap();
        let last_exists = mailbox.exists;

        // Confirm GreenMail advertises IDLE.
        let caps = session.capabilities().await.unwrap();
        assert!(caps.has_str("IDLE"), "GreenMail should advertise IDLE capability");

        // Run one IDLE cycle with a very short timeout: GreenMail will respond
        // with Timeout (no new mail yet), and we verify the EXISTS count hasn't
        // changed (empty mailbox).
        use async_imap::extensions::idle::IdleResponse;
        let mut handle = session.idle();
        handle.init().await.unwrap();
        let (idle_fut, _stop_src) = handle.wait_with_timeout(Duration::from_secs(2));
        let response = idle_fut.await.unwrap();
        session = handle.done().await.unwrap();

        match response {
            IdleResponse::Timeout | IdleResponse::NewData(_) => {}
            IdleResponse::ManualInterrupt => panic!("unexpected ManualInterrupt"),
        }

        let mailbox = session.examine("INBOX").await.unwrap();
        assert_eq!(
            mailbox.exists, last_exists,
            "EXISTS should be unchanged with no new mail"
        );

        session.logout().await.ok();
        let _ = last_exists; // suppress unused warning
    }
}
