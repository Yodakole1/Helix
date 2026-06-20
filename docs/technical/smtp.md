# SMTP sending

`src-tauri/src/smtp.rs` exposes `send_message(account_id, host, port,
use_starttls, to, subject, body)`. Same conventions as the IMAP layer:

- `account_id` doubles as both the SMTP login username and the message's
  From address
- Password is resolved from the OS keychain via `credentials::get_credential`,
  never passed in from the frontend
- `use_starttls` picks between lettre's two TLS strategies: `false` for
  implicit TLS (`AsyncSmtpTransport::relay()`, lettre's `Tls::Wrapper` mode
  — connects straight into a TLS handshake, the port-465 style), `true` for
  STARTTLS (`AsyncSmtpTransport::starttls_relay()`, `Tls::Required` — connects
  in plaintext and upgrades, the port-587 style). This is a caller-supplied
  flag, not inferred from `port`, since some providers run implicit TLS on
  nonstandard ports and a wrong guess should fail loudly rather than attempt
  the wrong handshake silently. Either mode requires the TLS step to
  succeed — `starttls_relay()` refuses to send credentials or mail at all if
  the server won't upgrade, so there's no opportunistic/downgradable path.
  IMAP (`imap.rs`) still only supports implicit TLS; STARTTLS for IMAP is a
  separate, not-yet-needed piece of work.

## Implementation notes

- Uses `lettre` with the `tokio1-native-tls` transport, so it shares
  Tauri's existing Tokio runtime and the same OS-native TLS backend as the
  IMAP layer, rather than introducing a second TLS stack.
- `lettre`'s `Credentials` type takes ownership of the password as a plain
  `String` with no zeroize support, so the same memory-scrubbing hardening
  used in `imap.rs`/`credentials.rs` doesn't fully carry over here — the
  password's lifetime is still bounded to this one async call (dropped
  normally when the transport goes out of scope at the end of
  `send_message`), just not actively wiped.
- Plain text body only for now (`ContentType::TEXT_PLAIN`) — no HTML body,
  no attachments. Tracked in the backlog.

## A real finding from testing against a real host

While verifying this against the real professional mail account used
elsewhere in these docs, `send_message` correctly *refused* to send:

```
send failed: Connection error: Connection error: error:0A000086:SSL
routines:tls_post_process_server_certificate:certificate verify failed:
...(hostname mismatch)
```

The IMAP service on that same host (port 993) has a certificate that
correctly matches the hostname — `list_folders`/`fetch_messages` work
fine against it (see `imap-core.md`). The SMTP service (port 465) on the
same hostname does not; its certificate doesn't match. This is a known
shared-hosting quirk (the IMAP daemon and the mail transfer agent are
often separate services, sometimes with separately-configured/outdated
certs). This is not a bug in `send_message` — refusing to send over a
connection whose certificate doesn't match the hostname is exactly the
correct, secure behavior. Don't "fix" this by relaxing certificate
validation in production code; if a real provider needs that, it points
to a problem with that provider's TLS setup, not with Helix.

## STARTTLS can't be verified against GreenMail

GreenMail (used for the local IMAP-side tests in `imap-core.md`) doesn't
implement the STARTTLS extension on its plain SMTP service at all —
confirmed by extracting `greenmail-standalone.jar` and checking: no class
in GreenMail's own SMTP server code mentions `STARTTLS`, only the
JavaMail *client* libraries it bundles (`org.eclipse.angus.mail.smtp.*`)
do. An EHLO against GreenMail's plain SMTP port confirms it: the
extension list it advertises has no `STARTTLS` entry. So unlike every
other path in this codebase, the STARTTLS branch of `send_message` has
no local-container option — it's only verified against a real server
(see below). If GreenMail ever adds STARTTLS support, a local
send-and-read-back test like `sends_and_lands_a_real_message_on_a_local_test_server`
below would be the natural way to cover it.

## Verification

- `rejects_bad_credentials_against_a_real_smtp_server` (`#[ignore]`, needs
  network): stores a bogus credential, calls `send_message` against
  `smtp.gmail.com:465` with `use_starttls: false`, confirms a clean
  SMTP-level auth rejection (not a network/TLS error).
- `rejects_bad_credentials_against_a_real_smtp_server_via_starttls`
  (`#[ignore]`, needs network): same shape, against `smtp.gmail.com:587`
  with `use_starttls: true` — confirms the STARTTLS upgrade itself
  succeeds and the failure happens at the SMTP-auth layer, not the TLS
  layer, which is the only way this branch gets exercised (see above).
- `sends_and_lands_a_real_message_on_a_local_test_server` (`#[ignore]`,
  needs the GreenMail container from `imap-core.md` with SMTPS also
  enabled): builds its own permissive-TLS mailer (GreenMail's cert is
  self-signed) to bypass `send_message`'s strict validation, sends a real
  message, then reads it back over IMAP to confirm it actually landed —
  not just that the SMTP transaction reported success. Start GreenMail
  with SMTPS added to the usual command:
  ```
  docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 -p 3465:3465 \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.smtps -Dgreenmail.setup.test.imaps -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
    greenmail/standalone:2.1.0
  ```
- Manually checked against the real professional mail host too (see
  finding above) — that attempt correctly failed at the TLS layer due to
  that host's own certificate mismatch, which is itself a useful
  confirmation that certificate validation is actually being enforced.
