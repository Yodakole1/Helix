//! Saving fetched attachment bytes to the user's Downloads folder. The
//! webview's own anchor-download path doesn't work reliably inside the Tauri
//! shell (WebKitGTK has no download manager wired up), so the reader pane
//! hands the bytes to this command instead and shows a toast with the path
//! it returns.

use base64::Engine;
use std::path::PathBuf;
use tauri::Manager;

/// Strips path separators and other filesystem-hostile characters so a
/// malicious attachment filename ("../../.bashrc") can't escape the
/// Downloads folder or collide with reserved names.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Picks a free path in `dir` for `filename`, appending " (1)", " (2)", ...
/// before the extension when the name is already taken -- the same behavior
/// browsers use, so a repeated download never overwrites an earlier one.
fn unique_path(dir: &PathBuf, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (filename.to_string(), String::new()),
    };
    for i in 1.. {
        let next = dir.join(format!("{stem} ({i}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    unreachable!("the counter loop always finds a free name");
}

/// Writes base64-encoded bytes to the OS Downloads folder and returns the
/// full path of the file that was written.
#[tauri::command]
pub async fn save_to_downloads(
    app: tauri::AppHandle,
    filename: String,
    content_base64: String,
) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("could not resolve the Downloads folder: {e}"))?;

    crate::run_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_base64.as_bytes())
            .map_err(|e| format!("attachment content is not valid base64: {e}"))?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let path = unique_path(&dir, &sanitize_filename(&filename));
        std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(path.display().to_string())
    })
    .await
}

/// Writes base64-encoded bytes to a temp staging directory and opens the
/// file with the OS's default application for its type. Backs the reader
/// pane's "Open" action (images preview in-app; everything else lands
/// here). The file stays in the temp dir -- "Download" is the separate,
/// explicit action that puts a copy in the Downloads folder.
#[tauri::command]
pub async fn open_attachment(filename: String, content_base64: String) -> Result<String, String> {
    crate::run_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_base64.as_bytes())
            .map_err(|e| format!("attachment content is not valid base64: {e}"))?;
        let dir = std::env::temp_dir().join("helix-attachments");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let path = unique_path(&dir, &sanitize_filename(&filename));
        std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;

        #[cfg(target_os = "linux")]
        let launched = std::process::Command::new("xdg-open").arg(&path).spawn();
        #[cfg(target_os = "macos")]
        let launched = std::process::Command::new("open").arg(&path).spawn();
        #[cfg(target_os = "windows")]
        let launched = std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(&path)
            .spawn();

        launched.map_err(|e| format!("could not open {} with the system viewer: {e}", path.display()))?;
        Ok(path.display().to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_separators_and_traversal() {
        let hostile = sanitize_filename("../../etc/passwd");
        assert!(!hostile.contains('/') && !hostile.contains('\\'));
        assert!(!hostile.starts_with('.'), "must not survive as a traversal/hidden name: {hostile}");
        assert_eq!(sanitize_filename("report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("we|ird:na*me?.txt"), "we_ird_na_me_.txt");
        assert_eq!(sanitize_filename(""), "attachment");
        assert_eq!(sanitize_filename("..."), "attachment");
    }

    #[test]
    fn unique_path_appends_a_counter_when_taken() {
        let dir = std::env::temp_dir().join(format!("helix-files-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let next = unique_path(&dir, "a.txt");
        assert_eq!(next.file_name().unwrap().to_string_lossy(), "a (1).txt");
        let fresh = unique_path(&dir, "b.txt");
        assert_eq!(fresh.file_name().unwrap().to_string_lossy(), "b.txt");
        std::fs::remove_dir_all(&dir).ok();
    }
}
