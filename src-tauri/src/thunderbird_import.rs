//! Discover account *settings* from a Thunderbird installation so someone
//! switching clients doesn't have to retype every server field. This reads
//! Thunderbird's `prefs.js` (the plain-text preferences file in each
//! profile) and reconstructs the IMAP/POP3 + SMTP configuration of every
//! real mail account it finds.
//!
//! Passwords are deliberately NOT imported. Thunderbird keeps them in an
//! NSS-encrypted store (`key4.db` + `logins.json`), often behind a primary
//! password, and decrypting that would mean bundling and driving NSS. So
//! this returns settings only; the onboarding form pre-fills from a chosen
//! account and the user types the password once, going through the exact
//! same verify-before-save path as a hand-entered account. Nothing here
//! writes anything or touches the keychain -- it's a read-only probe of
//! files the user already owns.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

/// One mail account reconstructed from a Thunderbird profile. Shaped to
/// pre-fill the onboarding form directly (no password -- see module docs).
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct DiscoveredAccount {
    pub email: String,
    pub display_name: Option<String>,
    /// "imap" or "pop3".
    pub protocol: String,
    pub incoming_host: String,
    pub incoming_port: u16,
    /// STARTTLS on the incoming server (vs. implicit TLS). Only meaningful
    /// for IMAP in Helix's model; POP3 is implicit-TLS only.
    pub incoming_starttls: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_starttls: bool,
}

/// Candidate directories Thunderbird stores profiles under, across the
/// platforms Helix targets. Only the ones that actually exist are returned.
fn thunderbird_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".thunderbird")); // Linux, native/deb/rpm packaging
        roots.push(home.join(".mozilla-thunderbird")); // older Linux packaging
        roots.push(home.join("Library/Thunderbird/Profiles")); // macOS
        // Sandboxed Linux packaging formats redirect the whole home
        // directory: Snap's writable area is `~/snap/<name>/common`, and
        // Flatpak's is `~/.var/app/<app-id>`. Ubuntu ships Thunderbird as a
        // Snap by default, so skipping this means the scan silently finds
        // nothing on a stock Ubuntu desktop despite Thunderbird being right
        // there.
        roots.push(home.join("snap/thunderbird/common/.thunderbird"));
        roots.push(home.join(".var/app/org.mozilla.Thunderbird/.thunderbird"));
    }
    if let Some(appdata) = dirs::config_dir() {
        // On Windows dirs::config_dir() is %APPDATA%.
        roots.push(appdata.join("Thunderbird/Profiles"));
    }
    roots.into_iter().filter(|p| p.is_dir()).collect()
}

/// Every `prefs.js` under the known roots. Each profile directory holds one;
/// a machine can have several profiles.
fn prefs_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in thunderbird_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let candidate = entry.path().join("prefs.js");
            if candidate.is_file() {
                files.push(candidate);
            }
        }
    }
    files
}

/// Parses the `user_pref("key", value);` lines of a `prefs.js` into a flat
/// map. String values are unquoted; numbers and booleans are kept as their
/// literal text (`"993"`, `"true"`) since every consumer here re-parses
/// them anyway. Anything that isn't a well-formed `user_pref` line (blank
/// lines, the file's comment header) is skipped.
fn parse_prefs(contents: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in contents.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("user_pref(") else { continue };
        let Some(inner) = rest.strip_suffix(");") else { continue };
        // inner is: "key", value
        let Some(comma) = inner.find(',') else { continue };
        let raw_key = inner[..comma].trim();
        let raw_val = inner[comma + 1..].trim();
        let Some(key) = unquote(raw_key) else { continue };
        let val = unquote(raw_val).unwrap_or_else(|| raw_val.to_string());
        map.insert(key, val);
    }
    map
}

/// Strips one layer of double quotes and undoes the two escapes Thunderbird
/// emits inside pref strings (`\"` and `\\`). Returns `None` for a value
/// that isn't quoted (a number or boolean), letting the caller keep the
/// literal.
fn unquote(value: &str) -> Option<String> {
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.replace("\\\\", "\\").replace("\\\"", "\""))
}

/// Turns a parsed pref map into the accounts it describes. Mirrors
/// Thunderbird's own indirection: the account manager lists account ids,
/// each account points at a server id and one or more identity ids, and the
/// identity points at an SMTP server id.
fn accounts_from_prefs(prefs: &HashMap<String, String>) -> Vec<DiscoveredAccount> {
    let get = |k: &str| prefs.get(k).map(|s| s.as_str());
    let mut out = Vec::new();

    let account_list = get("mail.accountmanager.accounts").unwrap_or("");
    for account in account_list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let Some(server) = get(&format!("mail.account.{account}.server")) else { continue };
        let prefix = format!("mail.server.{server}");

        let server_type = get(&format!("{prefix}.type")).unwrap_or("");
        let protocol = match server_type {
            "imap" => "imap",
            "pop3" => "pop3",
            // "none" (Local Folders), "nntp", "rss" -- not mail accounts.
            _ => continue,
        };
        let Some(incoming_host) = get(&format!("{prefix}.hostname")).filter(|h| !h.is_empty()) else {
            continue;
        };

        // socketType: 2 = STARTTLS, 3 = implicit TLS, 0/1 = none/legacy.
        let socket_type = get(&format!("{prefix}.socketType")).unwrap_or("");
        let incoming_starttls = socket_type == "2";
        let implicit_tls = socket_type == "3";
        let incoming_port = get(&format!("{prefix}.port"))
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or_else(|| default_incoming_port(protocol, incoming_starttls, implicit_tls));

        let username = get(&format!("{prefix}.userName")).unwrap_or("");

        // First identity wins -- Helix models one address per account.
        let identity = get(&format!("mail.account.{account}.identities"))
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("");
        let email = get(&format!("mail.identity.{identity}.useremail"))
            .filter(|e| !e.is_empty())
            .or(if username.contains('@') { Some(username) } else { None })
            .unwrap_or("")
            .to_string();
        if email.is_empty() {
            continue;
        }
        let display_name = get(&format!("mail.identity.{identity}.fullName"))
            .filter(|n| !n.is_empty())
            .map(str::to_string);

        // SMTP: the identity names its server; fall back to the global default.
        let smtp_key = get(&format!("mail.identity.{identity}.smtpServer"))
            .filter(|s| !s.is_empty())
            .or_else(|| get("mail.smtp.defaultserver"))
            .unwrap_or("");
        let smtp_prefix = format!("mail.smtpserver.{smtp_key}");
        let smtp_host = get(&format!("{smtp_prefix}.hostname")).unwrap_or("").to_string();
        // try_ssl: 2 = STARTTLS, 3 = implicit TLS, 0/1 = none/legacy.
        let smtp_ssl = get(&format!("{smtp_prefix}.try_ssl")).unwrap_or("");
        let smtp_starttls = smtp_ssl == "2";
        let smtp_implicit = smtp_ssl == "3";
        let smtp_port = get(&format!("{smtp_prefix}.port"))
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or(if smtp_starttls { 587 } else { 465 });
        let _ = smtp_implicit;

        out.push(DiscoveredAccount {
            email,
            display_name,
            protocol: protocol.to_string(),
            incoming_host: incoming_host.to_string(),
            incoming_port,
            incoming_starttls,
            smtp_host,
            smtp_port,
            smtp_starttls,
        });
    }
    out
}

fn default_incoming_port(protocol: &str, starttls: bool, _implicit: bool) -> u16 {
    match (protocol, starttls) {
        ("imap", true) => 143,
        ("imap", false) => 993,
        ("pop3", _) => 995,
        _ => 993,
    }
}

/// Reads every discoverable Thunderbird profile and returns the mail
/// accounts found, de-duplicated by address (a profile can list the same
/// address twice; two profiles can share one). Read-only: no password, no
/// writes, no keychain. An empty list means "nothing found" (Thunderbird
/// not installed, or no IMAP/POP3 accounts) -- not an error.
#[tauri::command]
pub async fn discover_thunderbird_accounts() -> Result<Vec<DiscoveredAccount>, String> {
    let mut found: Vec<DiscoveredAccount> = Vec::new();
    for path in prefs_files() {
        let Ok(contents) = std::fs::read_to_string(&path) else { continue };
        for account in accounts_from_prefs(&parse_prefs(&contents)) {
            if !found.iter().any(|a| a.email.eq_ignore_ascii_case(&account.email)) {
                found.push(account);
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
// Mozilla User Preferences
user_pref("mail.accountmanager.accounts", "account1,account2");
user_pref("mail.accountmanager.defaultaccount", "account1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "imap.example.com");
user_pref("mail.server.server1.port", 143);
user_pref("mail.server.server1.socketType", 2);
user_pref("mail.server.server1.userName", "alice@example.com");
user_pref("mail.identity.id1.useremail", "alice@example.com");
user_pref("mail.identity.id1.fullName", "Alice Example");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.smtpserver.smtp1.hostname", "smtp.example.com");
user_pref("mail.smtpserver.smtp1.port", 587);
user_pref("mail.smtpserver.smtp1.try_ssl", 2);
user_pref("mail.account.account2.server", "server2");
user_pref("mail.account.account2.identities", "id2");
user_pref("mail.server.server2.type", "pop3");
user_pref("mail.server.server2.hostname", "pop.other.net");
user_pref("mail.server.server2.socketType", 3);
user_pref("mail.identity.id2.useremail", "bob@other.net");
user_pref("mail.identity.id2.smtpServer", "smtp2");
user_pref("mail.smtpserver.smtp2.hostname", "smtp.other.net");
user_pref("mail.smtpserver.smtp2.try_ssl", 3);
user_pref("mail.account.account3.server", "server3");
user_pref("mail.server.server3.type", "none");
user_pref("mail.server.server3.hostname", "Local Folders");
"#;

    #[test]
    fn parses_imap_and_pop3_accounts_and_skips_local_folders() {
        let prefs = parse_prefs(SAMPLE);
        let accounts = accounts_from_prefs(&prefs);
        assert_eq!(accounts.len(), 2, "Local Folders (type none) must be skipped");

        let imap = &accounts[0];
        assert_eq!(imap.email, "alice@example.com");
        assert_eq!(imap.display_name.as_deref(), Some("Alice Example"));
        assert_eq!(imap.protocol, "imap");
        assert_eq!((imap.incoming_host.as_str(), imap.incoming_port, imap.incoming_starttls),
                   ("imap.example.com", 143, true));
        assert_eq!((imap.smtp_host.as_str(), imap.smtp_port, imap.smtp_starttls),
                   ("smtp.example.com", 587, true));

        let pop = &accounts[1];
        assert_eq!(pop.email, "bob@other.net");
        assert_eq!(pop.protocol, "pop3");
        // socketType 3 = implicit TLS, no explicit port -> POP3S default.
        assert_eq!((pop.incoming_host.as_str(), pop.incoming_port, pop.incoming_starttls),
                   ("pop.other.net", 995, false));
        // try_ssl 3 = implicit TLS -> not STARTTLS, default port 465.
        assert_eq!((pop.smtp_host.as_str(), pop.smtp_port, pop.smtp_starttls),
                   ("smtp.other.net", 465, false));
    }

    #[test]
    fn unquotes_escaped_pref_strings() {
        assert_eq!(unquote(r#""plain""#).as_deref(), Some("plain"));
        assert_eq!(unquote(r#""a \"b\" c""#).as_deref(), Some(r#"a "b" c"#));
        assert_eq!(unquote("993"), None); // unquoted number kept by caller
    }

    #[test]
    fn empty_prefs_yield_no_accounts() {
        assert!(accounts_from_prefs(&parse_prefs("")).is_empty());
    }

    /// Exercises the full command path -- profile discovery under a real
    /// `.thunderbird` directory tree plus parsing -- by pointing `HOME` at a
    /// throwaway dir. Ignored by default because it mutates `HOME` (which
    /// would race other tests) and touches the filesystem; run alone with
    /// `cargo test thunderbird_command_reads -- --ignored --test-threads=1`.
    #[tokio::test]
    #[ignore = "mutates HOME; run single-threaded"]
    async fn thunderbird_command_reads_a_planted_profile() {
        let tmp = std::env::temp_dir().join(format!("helix-tb-{}", std::process::id()));
        let profile = tmp.join(".thunderbird/abcd.default-release");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("prefs.js"), SAMPLE).unwrap();

        let prev = std::env::var_os("HOME");
        // Safe here: the test is single-threaded (see #[ignore] note).
        unsafe { std::env::set_var("HOME", &tmp) };
        let result = discover_thunderbird_accounts().await;
        match prev {
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        let _ = std::fs::remove_dir_all(&tmp);

        let accounts = result.expect("command should succeed");
        assert_eq!(accounts.len(), 2, "should find the two mail accounts, skip Local Folders");
        assert_eq!(accounts[0].email, "alice@example.com");
        assert_eq!(accounts[1].email, "bob@other.net");
    }
}
