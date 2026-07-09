//! "Default mail client" integration: registering Helix as the system's
//! mailto: handler and picking up a mailto: URL passed on the command line.
//!
//! The Linux side is the real implementation: the bundled .desktop file
//! (see `helix.desktop` next to tauri.conf.json) declares
//! `MimeType=x-scheme-handler/mailto;` and an `Exec=... %u` line, so once
//! the user makes Helix the default, clicking a mailto: link anywhere
//! launches Helix with the URL as an argument. `get_launch_mailto` hands
//! that argument to the frontend, which opens compose pre-filled.
//!
//! macOS/Windows default-client registration goes through OS UIs and
//! installer-level registry/plist entries; the commands report that
//! honestly instead of pretending.

/// The desktop-entry id the deb/rpm/AppImage bundles install under
/// `usr/share/applications/`. Tauri names it after `productName`.
#[cfg(target_os = "linux")]
const DESKTOP_ID: &str = "Helix.desktop";

/// True when Helix is currently the system handler for mailto: links.
#[tauri::command]
pub async fn is_default_mail_client() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        crate::run_blocking(|| {
            let out = std::process::Command::new("xdg-settings")
                .args(["check", "default-url-scheme-handler", "mailto", DESKTOP_ID])
                .output()
                .map_err(|e| format!("could not run xdg-settings: {e}"))?;
            Ok(String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("yes"))
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

/// Makes Helix the system handler for mailto: links.
#[tauri::command]
pub async fn set_default_mail_client() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::run_blocking(|| {
            let out = std::process::Command::new("xdg-settings")
                .args(["set", "default-url-scheme-handler", "mailto", DESKTOP_ID])
                .output()
                .map_err(|e| format!("could not run xdg-settings: {e}"))?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "xdg-settings refused: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("setting the default mail client from inside Helix is only wired up on Linux so far -- use your OS's default-apps settings".to_string())
    }
}

/// The mailto: URL Helix was launched with, if any. Consumed once by the
/// frontend at startup to open compose pre-filled.
#[tauri::command]
pub async fn get_launch_mailto() -> Result<Option<String>, String> {
    Ok(std::env::args().find(|arg| arg.starts_with("mailto:")))
}
