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
}

/// Deliberately small, hand-verified seed list. Only the IMAP/SMTP layers
/// we actually support (implicit TLS) belong here, and only for providers
/// whose ports are confirmed correct — a wrong hardcoded guess sends the
/// user a misleading error, which is worse than falling through to DNS SRV
/// or to manual entry. Expand this list only after verifying an entry
/// against the real provider.
fn known_provider(domain: &str) -> Option<DiscoveredConfig> {
    match domain {
        "gmail.com" | "googlemail.com" => Some(DiscoveredConfig {
            imap: ServerConfig {
                host: "imap.gmail.com".to_string(),
                port: 993,
            },
            smtp: ServerConfig {
                host: "smtp.gmail.com".to_string(),
                port: 465,
            },
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
        (Some(imap), Some(smtp)) => Ok(DiscoveredConfig { imap, smtp }),
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
        let result = discover_server_config("someone@fastmail.com".to_string())
            .await
            .expect("fastmail.com publishes SRV records and should resolve");

        assert_eq!(result.imap.host, "imap.fastmail.com");
        assert_eq!(result.imap.port, 993);
        assert_eq!(result.smtp.host, "smtp.fastmail.com");
        assert_eq!(result.smtp.port, 465);
    }

    #[tokio::test]
    #[ignore = "requires network access to a real DNS resolver"]
    async fn fails_cleanly_for_a_domain_with_no_mail_srv_records() {
        let result = discover_server_config("someone@example.com".to_string()).await;
        assert!(result.is_err());
    }
}
