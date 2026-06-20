mod account;
mod credentials;
mod discovery;
mod imap;
mod smtp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      credentials::store_credential,
      credentials::get_credential,
      credentials::delete_credential,
      imap::list_folders,
      imap::fetch_messages,
      imap::fetch_message_body,
      account::add_account,
      smtp::send_message,
      discovery::discover_server_config,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
