import { invoke } from "@tauri-apps/api/core";

// Wraps src-tauri/src/discovery.rs's discover_server_config -- resolves
// IMAP/SMTP host+port from just an email address (hardcoded table first,
// then a DNS SRV fallback per RFC 6186), so onboarding doesn't require
// the user to already know their provider's server settings.

export interface ServerConfig {
  host: string;
  port: number;
}

export interface DiscoveredConfig {
  imap: ServerConfig;
  smtp: ServerConfig;
  // Whether the SMTP connection requires STARTTLS (port 587 style) rather
  // than implicit TLS (port 465 style). Always false for DNS SRV results;
  // set to true for providers like Outlook and iCloud that use port 587.
  smtpUseStarttls: boolean;
}

export function discoverServerConfig(email: string): Promise<DiscoveredConfig> {
  return invoke("discover_server_config", { email });
}
