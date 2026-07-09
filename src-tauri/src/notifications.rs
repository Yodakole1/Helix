//! Desktop notification delivery.
//!
//! This module exists because tauri-plugin-notification's own `notify`
//! command never produced a visible banner on GNOME. The plugin delivers
//! Linux notifications through notify-rust, which opens a fresh DBus
//! connection per notification and drops it as soon as the `Notify` call
//! returns. GNOME Shell watches each notification's sender bus name and,
//! when that name vanishes, destroys every notification source it can
//! attribute to a running application (`FdoNotificationDaemonSource.
//! _onNameVanished` -- it only spares senders whose pid maps to no window,
//! which is why short-lived `notify-send` works). The observable result:
//! `Notify` was answered with an id and ~20ms later GNOME emitted
//! `NotificationClosed` reason 2 ("dismissed"), before the banner was ever
//! drawn. Notifications from this app simply never appeared -- in dev and
//! packaged builds alike. Diagnosed on GNOME Shell 46 by monitoring the
//! session bus while the app sent test notifications.
//!
//! The fix is what libnotify-based apps get implicitly: keep **one**
//! session-bus connection alive for the process lifetime and send every
//! `Notify` over it. The notification then also stays in GNOME's
//! notification list instead of being reaped when a per-call connection
//! would have closed. On non-Linux platforms the plugin's delivery
//! (mac-notification-sys / WinRT) has no such failure mode, so this command
//! just forwards to the plugin's builder there.

use crate::debug_log;

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::OnceLock;

    /// The process-lifetime session-bus connection. Everything hinges on
    /// this never being dropped -- see the module docs.
    fn connection() -> Result<&'static zbus::blocking::Connection, String> {
        static CONN: OnceLock<zbus::blocking::Connection> = OnceLock::new();
        if let Some(conn) = CONN.get() {
            return Ok(conn);
        }
        let fresh = zbus::blocking::Connection::session()
            .map_err(|e| format!("could not connect to the session bus: {e}"))?;
        // A racing second initializer just drops its extra connection.
        Ok(CONN.get_or_init(|| fresh))
    }

    pub fn send(title: &str, body: &str, icon: Option<&str>) -> Result<(), String> {
        let conn = connection()?;
        // `desktop-entry` lets GNOME attribute the notification to the
        // installed Helix.desktop entry (per-app notification settings,
        // proper name/icon). Harmless when unmatched, e.g. in dev builds.
        let hints: HashMap<&str, zbus::zvariant::Value> =
            HashMap::from([("desktop-entry", zbus::zvariant::Value::from("Helix"))]);
        conn.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                "Helix",                    // app_name
                0u32,                       // replaces_id (0 = always a new one)
                icon.unwrap_or(""),         // app_icon (file path or theme name)
                title,                      // summary
                body,                       // body
                Vec::<&str>::new(),         // actions
                hints,                      // hints
                -1i32,                      // expire_timeout (-1 = server default)
            ),
        )
        .map_err(|e| format!("Notify call failed: {e}"))?;
        Ok(())
    }
}

/// Shows a desktop notification. All frontend call sites (new mail, calendar
/// reminders, the Settings test button) go through this instead of the
/// notification plugin's JS API -- see the module docs for why the plugin's
/// own path is broken on GNOME.
#[tauri::command]
pub async fn send_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    icon: Option<String>,
) -> Result<(), String> {
    let result = deliver(app, title.clone(), body, icon).await;
    match &result {
        Ok(()) => debug_log::record("notify", format!("sent \"{title}\"")),
        Err(e) => debug_log::record("notify", format!("failed to send \"{title}\": {e}")),
    }
    result
}

#[cfg(target_os = "linux")]
async fn deliver(
    _app: tauri::AppHandle,
    title: String,
    body: String,
    icon: Option<String>,
) -> Result<(), String> {
    // The blocking DBus round trip must stay off the main thread (the GTK
    // event loop) like every other blocking command in this app.
    crate::run_blocking(move || linux::send(&title, &body, icon.as_deref())).await
}

#[cfg(not(target_os = "linux"))]
async fn deliver(
    app: tauri::AppHandle,
    title: String,
    body: String,
    icon: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.show().map_err(|e| format!("notification failed: {e}"))
}
