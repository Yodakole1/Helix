mod account;
mod account_import;
mod bayes;
mod cache;
mod caldav;
mod carddav;
mod credentials;
mod debug_log;
mod discovery;
mod drafts;
mod files;
mod ics;
mod idle;
mod identities;
mod imap;
mod lock;
mod mailstore;
mod mailto;
mod notifications;
mod oauth;
mod pgp;
mod pop3;
mod smime;
mod smtp;
mod snooze;
mod thunderbird_import;

/// Runs a blocking closure on the runtime's dedicated blocking thread pool
/// and flattens the join error into the command's error string. Synchronous
/// Tauri commands execute on the main thread, which on Linux is also the GTK
/// event loop -- any command doing blocking work (network, keychain DBus,
/// Argon2, key generation) must hop through this instead or the whole window
/// stops responding while it runs.
pub(crate) async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(idle::IdleRegistry::new())
    .setup(|app| {
      // Desktop-only: the updater has no mobile story (mobile updates go
      // through the app stores), and registering it in setup() keeps the
      // mobile entry point compiling once that target exists.
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
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
      credentials::store_credential_cmd,
      credentials::get_credential_cmd,
      credentials::delete_credential_cmd,
      imap::list_folders,
      imap::fetch_messages,
      imap::fetch_threaded_messages,
      imap::fetch_message_body,
      imap::fetch_attachment,
      imap::fetch_message_source,
      imap::search_messages,
      imap::set_message_seen,
      imap::set_message_flagged,
      imap::set_messages_seen,
      imap::set_messages_flagged,
      imap::mark_folder_seen,
      imap::move_message_to_folder,
      imap::move_messages_to_folder,
      imap::create_folder,
      imap::delete_folder,
      imap::rename_folder,
      imap::empty_folder,
      imap::subscribe_folder,
      imap::unsubscribe_folder,
      imap::list_subscribed_folders,
      account::add_account,
      account::add_oauth_account,
      account::reauthorize_oauth_account,
      account::add_pop3_account,
      account::update_account,
      account::list_accounts,
      account::remove_account,
      account::fetch_unified_inbox,
      account::report_spam,
      account_import::import_accounts_file,
      account_import::import_thunderbird_account,
      thunderbird_import::discover_thunderbird_accounts,
      smtp::send_message,
      smtp::send_mdn,
      discovery::discover_server_config,
      oauth::oauth_provider_info,
      files::save_to_downloads,
      files::open_attachment,
      mailto::is_default_mail_client,
      mailto::set_default_mail_client,
      mailto::get_launch_mailto,
      mailstore::import_mbox,
      mailstore::import_eml_files,
      mailstore::export_folder_mbox,
      mailstore::export_account_mbox,
      cache::search_contacts,
      cache::list_contacts,
      cache::delete_contact,
      cache::update_contact,
      cache::add_contact,
      cache::cache_stats,
      cache::clear_cache,
      cache::load_cached_messages,
      cache::load_cached_message_body,
      cache::load_cached_attachment,
      cache::load_cached_pop3_messages,
      cache::load_cached_pop3_message_body,
      cache::load_cached_pop3_attachment,
      cache::search_local_messages,
      pop3::list_messages,
      pop3::fetch_message,
      pop3::pop3_fetch_attachment,
      pop3::delete_message,
      pgp::generate_keypair,
      pgp::export_public_key,
      pgp::import_own_key,
      pgp::import_contact_key,
      pgp::list_own_keys,
      pgp::list_contact_keys,
      pgp::delete_own_key,
      pgp::delete_contact_key,
      pgp::discover_pgp_key_wkd,
      pgp::ensure_contact_key_wkd,
      drafts::save_draft,
      drafts::list_drafts,
      drafts::get_draft,
      drafts::delete_draft,
      drafts::queue_for_send,
      drafts::cancel_queued_send,
      drafts::list_outbox,
      drafts::flush_outbox,
      idle::start_idle,
      idle::stop_idle,
      idle::stop_all_idle,
      identities::add_identity,
      identities::list_identities,
      identities::delete_identity,
      identities::mute_thread,
      identities::unmute_thread,
      identities::is_thread_muted,
      identities::list_muted_threads,
      cache::get_unseen_count,
      ics::parse_ics_invite,
      ics::respond_to_invite,
      bayes::train_message,
      bayes::retract_message,
      bayes::get_spam_score,
      bayes::get_bayes_stats,
      lock::get_app_lock_config,
      lock::set_app_lock_password,
      lock::clear_app_lock_password,
      lock::verify_app_lock_password,
      lock::register_app_lock_passkey,
      lock::passkey_unlock,
      lock::clear_app_lock_passkey,
      snooze::snooze_message,
      snooze::cancel_snooze,
      snooze::list_due_snoozed,
      snooze::list_all_snoozed,
      smime::import_smime_cert,
      smime::export_smime_cert,
      smime::list_own_smime_certs,
      smime::delete_smime_cert,
      smime::import_contact_smime_cert,
      smime::list_contact_smime_certs,
      smime::delete_contact_smime_cert,
      smime::get_smime_cert_info,
      carddav::add_carddav_source,
      carddav::list_carddav_sources,
      carddav::delete_carddav_source,
      carddav::sync_carddav,
      carddav::discover_carddav,
      caldav::add_caldav_source,
      caldav::list_caldav_sources,
      caldav::update_caldav_source_color,
      caldav::delete_caldav_source,
      caldav::sync_caldav,
      caldav::discover_caldav,
      caldav::list_calendar_events,
      caldav::create_event,
      caldav::update_event,
      caldav::delete_event,
      debug_log::get_debug_log,
      debug_log::clear_debug_log,
      notifications::send_desktop_notification,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
