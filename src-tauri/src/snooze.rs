use crate::cache::{self, SnoozedMessage};

fn generate_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
pub async fn snooze_message(
    account_id: String,
    folder: Option<String>,
    uid: Option<i64>,
    pop3_uidl: Option<String>,
    subject: Option<String>,
    sender: Option<String>,
    snooze_until: String,
) -> Result<String, String> {
    let id = generate_id();
    let conn = cache::open()?;
    cache::insert_snooze(
        &conn,
        &id,
        &account_id,
        folder.as_deref(),
        uid,
        pop3_uidl.as_deref(),
        subject.as_deref(),
        sender.as_deref(),
        &snooze_until,
    )?;
    Ok(id)
}

#[tauri::command]
pub async fn cancel_snooze(id: String) -> Result<(), String> {
    let conn = cache::open()?;
    cache::delete_snooze(&conn, &id)
}

#[tauri::command]
pub async fn list_due_snoozed() -> Result<Vec<SnoozedMessage>, String> {
    let conn = cache::open()?;
    cache::list_due_snoozed(&conn)
}

#[tauri::command]
pub async fn list_all_snoozed(account_id: String) -> Result<Vec<SnoozedMessage>, String> {
    let conn = cache::open()?;
    cache::list_all_snoozed(&conn, &account_id)
}
