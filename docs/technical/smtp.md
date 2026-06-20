# SMTP sending

`src-tauri/src/smtp.rs` exposes `send_message(account_id, host, port, to,
subject, body)`. Same conventions as the IMAP layer:

- `account_id` doubles as both the SMTP login username and the message's
  From address
- Password is resolved from the OS keychain via `credentials::get_credential`,
  never passed in from the frontend
- Implicit TLS only (`AsyncSmtpTransport::relay()`, i.e. lettre's
  `Tls::Wrapper` mode) — connects straight into a TLS handshake rather than
  starting plaintext and upgrading via STARTTLS. This matches the IMAP
  layer's all-implicit-TLS approach (993 for IMAP, 465 for SMTP). STARTTLS
  (port 587) isn't supported yet — see the backlog if a provider needs it.

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

## Verification

- `rejects_bad_credentials_against_a_real_smtp_server` (`#[ignore]`, needs
  network): stores a bogus credential, calls `send_message` against
  `smtp.gmail.com:465`, confirms a clean SMTP-level auth rejection (not a
  network/TLS error).
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
