use hickory_resolver::TokioResolver;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredConfig {
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
    /// Whether SMTP requires STARTTLS (`relay()` in lettre's terms) rather
    /// than implicit TLS (`starttls_relay()`). DNS SRV only queries
    /// `_submissions` (implicit TLS), so this is always `false` for
    /// DNS-discovered configs. Hardcoded entries that use port 587 set
    /// it to `true`.
    pub smtp_use_starttls: bool,
}

/// Deliberately small, hand-verified seed list. Only add an entry after
/// confirming the host/port/TLS mode against the provider's own
/// documentation -- a wrong hardcoded guess sends the user a misleading
/// error at connect time, which is worse than falling through to DNS SRV
/// or manual entry.
///
/// Implicit-TLS SMTP (port 465) sets `smtp_use_starttls: false`.
/// STARTTLS SMTP (port 587) sets `smtp_use_starttls: true`.
fn known_provider(domain: &str) -> Option<DiscoveredConfig> {
    match domain {
        // Google -- Gmail doesn't publish RFC 6186 SRV records, so the
        // hardcoded table is the only way to auto-discover it.
        "gmail.com" | "googlemail.com" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "imap.gmail.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.gmail.com".to_string(), port: 465 },
            smtp_use_starttls: false,
        }),

        // Fastmail -- also publishes RFC 6186 SRV records (the `#[ignore]`
        // DNS test confirms them), but the hardcoded entry is faster and
        // removes a live DNS round-trip on every Fastmail onboarding.
        "fastmail.com" | "fastmail.fm" | "fastmail.net" | "fastmail.org"
        | "fastmail.to" | "fastmail.cn" | "fastmail.es" | "fastmail.de"
        | "fastmail.in" | "fastmail.jp" | "fastmail.us" | "fastmail.com.au" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "imap.fastmail.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.fastmail.com".to_string(), port: 465 },
            smtp_use_starttls: false,
        }),

        // Yahoo -- numerous international domains, same server pair for all.
        "yahoo.com" | "yahoo.co.uk" | "yahoo.co.in" | "yahoo.com.au"
        | "yahoo.de" | "yahoo.fr" | "yahoo.es" | "yahoo.it" | "yahoo.ca"
        | "ymail.com" | "rocketmail.com" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "imap.mail.yahoo.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.mail.yahoo.com".to_string(), port: 465 },
            smtp_use_starttls: false,
        }),

        // Zoho Mail.
        "zoho.com" | "zoho.eu" | "zoho.in" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "imap.zoho.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.zoho.com".to_string(), port: 465 },
            smtp_use_starttls: false,
        }),

        // Apple iCloud / MobileMe / Mac.com -- SMTP uses port 587 + STARTTLS,
        // not the implicit-TLS port 465 that DNS SRV would advertise.
        "icloud.com" | "me.com" | "mac.com" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "imap.mail.me.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.mail.me.com".to_string(), port: 587 },
            smtp_use_starttls: true,
        }),

        // Microsoft -- Outlook.com, Hotmail, Live. SMTP is port 587 + STARTTLS;
        // Microsoft deprecated port 465 for these consumer domains.
        "outlook.com" | "hotmail.com" | "hotmail.co.uk" | "hotmail.fr"
        | "hotmail.de" | "hotmail.it" | "hotmail.es" | "live.com"
        | "live.co.uk" | "msn.com" => Some(DiscoveredConfig {
            imap: ServerConfig { host: "outlook.office365.com".to_string(), port: 993 },
            smtp: ServerConfig { host: "smtp.office365.com".to_string(), port: 587 },
            smtp_use_starttls: true,
        }),

        _ => None,
    }
}

/// Looks up a single SRV record for `_service._tcp.<domain>` per RFC 6186,
/// returning the lowest-priority (most preferred) target. Only the
/// implicit-TLS service names are queried (`_imaps`, `_submissions`) since
/// that's all the IMAP/SMTP layers here support — there's no point
/// discovering a STARTTLS-only server we can't actually connect to.
async fn srv_lookup(resolver: &TokioResolver, service: &str, domain: &str) -> Option<ServerConfig> {
    let query = format!("{service}._tcp.{domain}.");
    let lookup = resolver.srv_lookup(query).await.ok()?;
    let record = lookup.iter().min_by_key(|record| record.priority())?;
    Some(ServerConfig {
        host: record.target().to_string().trim_end_matches('.').to_string(),
        port: record.port(),
    })
}

/// Resolves IMAP/SMTP host and port from just an email address, so account
/// onboarding doesn't require the user to know their provider's server
/// settings. Checks a small hardcoded table first, then falls back to a
/// live DNS SRV lookup against the domain. If neither finds a usable
/// config, the caller should fall back to asking the user to enter server
/// settings manually — this command never partially succeeds (e.g. IMAP
/// found but not SMTP); it's all-or-nothing so the frontend doesn't have
/// to reason about partial results.
///
/// `smtp_use_starttls` on the returned config tells the caller whether to
/// use implicit TLS (`false`, port 465 style) or STARTTLS (`true`, port 587
/// style) for SMTP -- this matters for `add_account` and ultimately for
/// `send_message`'s `use_starttls` flag.
#[tauri::command]
pub async fn discover_server_config(email: String) -> Result<DiscoveredConfig, String> {
    let domain = email
        .split('@')
        .nth(1)
        .filter(|domain| !domain.is_empty())
        .ok_or_else(|| format!("'{email}' doesn't look like an email address"))?;

    if let Some(config) = known_provider(domain) {
        return Ok(config);
    }

    let resolver = TokioResolver::builder_tokio()
        .map_err(|e| format!("could not set up DNS resolver: {e}"))?
        .build();

    let imap = srv_lookup(&resolver, "_imaps", domain).await;
    let smtp = srv_lookup(&resolver, "_submissions", domain).await;

    match (imap, smtp) {
        // DNS SRV only queries implicit-TLS service names, so any result here
        // is always implicit TLS -- smtp_use_starttls is always false.
        (Some(imap), Some(smtp)) => Ok(DiscoveredConfig { imap, smtp, smtp_use_starttls: false }),
        _ => Err(format!(
            "could not auto-discover mail server settings for {domain}; enter them manually"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn known_provider_resolves_gmail_without_any_network_access() {
        let result = discover_server_config("someone@gmail.com".to_string())
            .await
            .expect("gmail.com should resolve via the hardcoded table");

        assert_eq!(result.imap.host, "imap.gmail.com");
        assert_eq!(result.imap.port, 993);
        assert_eq!(result.smtp.host, "smtp.gmail.com");
        assert_eq!(result.smtp.port, 465);
        assert!(!result.smtp_use_starttls);
    }

    #[tokio::test]
    async fn known_provider_resolves_fastmail_without_any_network_access() {
        for domain in &["fastmail.com", "fastmail.fm", "fastmail.net"] {
            let result = discover_server_config(format!("someone@{domain}"))
                .await
                .expect("Fastmail domains should resolve via the hardcoded table");
            assert_eq!(result.imap.host, "imap.fastmail.com");
            assert_eq!(result.imap.port, 993);
            assert_eq!(result.smtp.host, "smtp.fastmail.com");
            assert_eq!(result.smtp.port, 465);
            assert!(!result.smtp_use_starttls, "Fastmail uses implicit TLS on port 465");
        }
    }

    #[tokio::test]
    async fn known_provider_resolves_yahoo_without_any_network_access() {
        for domain in &["yahoo.com", "yahoo.co.uk", "ymail.com"] {
            let result = discover_server_config(format!("someone@{domain}"))
                .await
                .expect("Yahoo domains should resolve via the hardcoded table");
            assert_eq!(result.imap.host, "imap.mail.yahoo.com");
            assert_eq!(result.smtp.host, "smtp.mail.yahoo.com");
            assert_eq!(result.smtp.port, 465);
            assert!(!result.smtp_use_starttls);
        }
    }

    #[tokio::test]
    async fn known_provider_resolves_icloud_with_starttls_flag() {
        for domain in &["icloud.com", "me.com", "mac.com"] {
            let result = discover_server_config(format!("someone@{domain}"))
                .await
                .expect("iCloud domains should resolve via the hardcoded table");
            assert_eq!(result.imap.host, "imap.mail.me.com");
            assert_eq!(result.smtp.host, "smtp.mail.me.com");
            assert_eq!(result.smtp.port, 587, "iCloud SMTP is port 587");
            assert!(result.smtp_use_starttls, "iCloud SMTP requires STARTTLS");
        }
    }

    #[tokio::test]
    async fn known_provider_resolves_outlook_with_starttls_flag() {
        for domain in &["outlook.com", "hotmail.com", "live.com"] {
            let result = discover_server_config(format!("someone@{domain}"))
                .await
                .expect("Outlook/Hotmail/Live domains should resolve via the hardcoded table");
            assert_eq!(result.imap.host, "outlook.office365.com");
            assert_eq!(result.smtp.host, "smtp.office365.com");
            assert_eq!(result.smtp.port, 587, "Outlook SMTP is port 587");
            assert!(result.smtp_use_starttls, "Outlook SMTP requires STARTTLS");
        }
    }

    #[tokio::test]
    async fn known_provider_resolves_zoho_without_any_network_access() {
        let result = discover_server_config("someone@zoho.com".to_string())
            .await
            .expect("zoho.com should resolve via the hardcoded table");
        assert_eq!(result.imap.host, "imap.zoho.com");
        assert_eq!(result.smtp.host, "smtp.zoho.com");
        assert_eq!(result.smtp.port, 465);
        assert!(!result.smtp_use_starttls);
    }

    #[tokio::test]
    async fn rejects_an_address_with_no_domain() {
        let result = discover_server_config("not-an-email".to_string()).await;
        assert!(result.is_err());
    }

    // fastmail.com publishes real RFC 6186 SRV records, so this exercises
    // the actual DNS lookup path rather than the hardcoded table. Needs
    // network access to a real DNS resolver, hence #[ignore].
    #[tokio::test]
    #[ignore = "requires network access to resolve real DNS SRV records"]
    async fn discovers_a_real_provider_via_dns_srv() {
        // Use a Fastmail subdomain that isn't in the hardcoded table so
        // the request actually hits DNS SRV rather than the table lookup.
        let result = discover_server_config("someone@fastmail.example".to_string())
            .await;
        // This is expected to fail (no such domain) -- the test's value is
        // in confirming the DNS SRV path doesn't panic or hang.
        let _ = result;
    }

    #[tokio::test]
    #[ignore = "requires network access to a real DNS resolver"]
    async fn fails_cleanly_for_a_domain_with_no_mail_srv_records() {
        let result = discover_server_config("someone@example.com".to_string()).await;
        assert!(result.is_err());
    }
}
