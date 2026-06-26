# Provider auto-discovery

`src-tauri/src/discovery.rs` exposes `discover_server_config(email)`,
which resolves IMAP/SMTP host and port from just an email address, so
account onboarding doesn't require the user to already know their
provider's server settings.

## How it resolves

1. **Hardcoded table first.** `known_provider` in `discovery.rs` -- a
   hand-verified list of providers whose host/port/TLS mode is confirmed
   against their own documentation. Faster than DNS, no network required,
   and the source of truth for providers that don't publish RFC 6186 SRV
   records (Gmail, Yahoo). Only add an entry after verifying it; a wrong
   hardcoded guess produces a confusing failure at connect time instead of
   a clean "couldn't auto-discover" message now.
2. **DNS SRV lookup**, per [RFC 6186](https://www.rfc-editor.org/rfc/rfc6186),
   via the `hickory-resolver` crate using the system's configured DNS
   resolver. Only queries `_imaps._tcp.<domain>` and
   `_submissions._tcp.<domain>` — the implicit-TLS service names — since
   that's all the IMAP/SMTP layers in this codebase support.
3. **All-or-nothing.** If either IMAP or SMTP can't be resolved, the whole
   call fails rather than returning a half-complete config.

## `smtp_use_starttls` flag

`DiscoveredConfig` carries `smtp_use_starttls: bool` alongside the host
and port. The frontend (`AddAccountModal`) passes it straight to
`add_account` so it ends up in the account's stored `AccountRecord` and
ultimately in `send_message`'s `use_starttls` argument.

- **Implicit TLS (port 465):** `smtp_use_starttls: false`. All hardcoded
  entries except iCloud and Outlook; all DNS SRV results (since SRV only
  queries `_submissions`, the implicit-TLS service name).
- **STARTTLS (port 587):** `smtp_use_starttls: true`. iCloud
  (`imap.mail.me.com` / `smtp.mail.me.com:587`) and Outlook/Hotmail/Live
  (`outlook.office365.com` / `smtp.office365.com:587`) both require
  STARTTLS on port 587 — their documentation doesn't list port 465.

## Hardcoded provider table

| Provider | IMAP host | SMTP host | SMTP port | STARTTLS |
|---|---|---|---|---|
| Gmail / Googlemail | imap.gmail.com | smtp.gmail.com | 465 | no |
| Fastmail (all domains) | imap.fastmail.com | smtp.fastmail.com | 465 | no |
| Yahoo / Ymail / Rocketmail | imap.mail.yahoo.com | smtp.mail.yahoo.com | 465 | no |
| Zoho Mail | imap.zoho.com | smtp.zoho.com | 465 | no |
| iCloud / me.com / mac.com | imap.mail.me.com | smtp.mail.me.com | 587 | yes |
| Outlook / Hotmail / Live / MSN | outlook.office365.com | smtp.office365.com | 587 | yes |

All IMAP connections use port 993 (implicit TLS) regardless of provider.

## Why not Mozilla's ISPDB / ispdb autoconfig?

DNS SRV was chosen because it's a provider-controlled mechanism with no
third-party service in the loop -- providers that care about autodiscovery
publish their own SRV records, which fits Helix's "no middleman servers"
positioning better than depending on a database hosted by Mozilla. The
tradeoff: SRV adoption is inconsistent -- some real providers (Gmail,
Yahoo) don't publish these records at all, which is exactly why the
hardcoded table exists as a first check.

## Verification

All hardcoded-table tests run without network access and are part of the
default `cargo test` pass:

- `known_provider_resolves_gmail_without_any_network_access`
- `known_provider_resolves_fastmail_without_any_network_access`
- `known_provider_resolves_yahoo_without_any_network_access`
- `known_provider_resolves_icloud_with_starttls_flag`
- `known_provider_resolves_outlook_with_starttls_flag`
- `known_provider_resolves_zoho_without_any_network_access`
- `rejects_an_address_with_no_domain`

Network-dependent (`#[ignore]`):
- `discovers_a_real_provider_via_dns_srv` -- exercises the DNS SRV path
- `fails_cleanly_for_a_domain_with_no_mail_srv_records` -- confirms
  `example.com` fails cleanly
