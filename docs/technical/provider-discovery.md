# Provider auto-discovery

`src-tauri/src/discovery.rs` exposes `discover_server_config(email)`,
which resolves IMAP/SMTP host and port from just an email address, so
account onboarding doesn't require the user to already know their
provider's server settings.

## How it resolves

1. **Hardcoded table first.** A deliberately small, hand-verified list of
   known providers (`known_provider` in `discovery.rs`) — currently just
   `gmail.com`/`googlemail.com`. Only add an entry here after actually
   verifying it; a wrong hardcoded guess produces a confusing failure
   later (at connect time) instead of a clean "couldn't auto-discover"
   message now. Most real providers (Outlook, Yahoo, iCloud, etc.) are
   deliberately *not* in this table yet because their exact implicit-TLS
   port behavior wasn't verified — better to fall through to manual entry
   than ship a guess.
2. **DNS SRV lookup**, per [RFC 6186](https://www.rfc-editor.org/rfc/rfc6186),
   via the `hickory-resolver` crate using the system's configured DNS
   resolver. Only queries `_imaps._tcp.<domain>` and
   `_submissions._tcp.<domain>` — the implicit-TLS service names — since
   that's all the IMAP/SMTP layers in this codebase support. There's no
   point discovering a STARTTLS-only server (`_imap`/`_submission`) we
   can't actually connect to.
3. **All-or-nothing.** If either IMAP or SMTP can't be resolved, the whole
   call fails rather than returning a half-complete config — the frontend
   should fall back to asking the user for manual server settings rather
   than trying to reason about a partially-discovered result.

## Why not Mozilla's ISPDB / ispdb autoconfig?

That's the other common approach (Thunderbird's centrally-hosted
provider database, queried over HTTPS). DNS SRV was chosen instead
because it's a published, provider-controlled mechanism with no
third-party service in the loop — providers that care about
autodiscovery publish their own SRV records, which fits Helix's
"no middleman servers" positioning better than depending on a database
hosted by Mozilla. The tradeoff: SRV adoption is inconsistent — some real
providers (notably Gmail) don't publish these records at all, which is
exactly why the hardcoded table exists as a first check.

## Verification

- `known_provider_resolves_gmail_without_any_network_access` and
  `rejects_an_address_with_no_domain` need no network and run in the
  default `cargo test` pass.
- `discovers_a_real_provider_via_dns_srv` (`#[ignore]`, needs network)
  resolves `fastmail.com`, which actually publishes RFC 6186 SRV records
  (confirmed independently via `dig +short SRV _imaps._tcp.fastmail.com`
  before writing the test), and asserts the exact host/port returned.
- `fails_cleanly_for_a_domain_with_no_mail_srv_records` (`#[ignore]`,
  needs network) confirms `example.com` — which publishes no mail SRV
  records — fails cleanly rather than hanging or panicking.
