mod account;
mod cache;
mod credentials;
mod discovery;
mod drafts;
mod idle;
mod imap;
mod pgp;
mod pop3;
mod smtp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .manage(idle::IdleRegistry::new())
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
      imap::fetch_threaded_messages,
      imap::fetch_message_body,
      imap::fetch_attachment,
      imap::set_message_seen,
      imap::set_message_flagged,
      imap::move_message_to_folder,
      account::add_account,
      account::list_accounts,
      account::remove_account,
      account::fetch_unified_inbox,
      smtp::send_message,
      discovery::discover_server_config,
      cache::search_contacts,
      cache::cache_stats,
      cache::clear_cache,
      pop3::list_messages,
      pop3::fetch_message,
      pop3::pop3_fetch_attachment,
      pop3::delete_message,
      pgp::generate_keypair,
      pgp::export_public_key,
      pgp::import_own_key,
      pgp::import_contact_key,
      drafts::save_draft,
      drafts::list_drafts,
      drafts::get_draft,
      drafts::delete_draft,
      drafts::queue_for_send,
      drafts::list_outbox,
      drafts::flush_outbox,
      idle::start_idle,
      idle::stop_idle,
      idle::stop_all_idle,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
