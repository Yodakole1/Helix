# POP3 support

A second, simpler protocol module alongside `imap.rs`, for the "legacy
offline download" case product requirements called out — not the
primary sync model. `src-tauri/src/pop3.rs` exposes `list_messages`,
`fetch_message`, `pop3_fetch_attachment`, and `delete_message`.

## Why hand-rolled, no new dependency

POP3 (RFC 1939) is a small line-based text protocol: a handful of
single-line commands (`USER`, `PASS`, `STAT`, `LIST`, `RETR`, `DELE`,
`UIDL`, `TOP`, `QUIT`), single-line `+OK`/`-ERR` responses, and a few
multi-line responses terminated by a lone `.` line, with leading-`.`
byte-stuffing on data lines (RFC 1939 §3). There's no actively maintained
async POP3 crate worth depending on, and the protocol is simple enough
that hand-rolling it directly over `tokio::net::TcpStream` +
`tokio_native_tls` is both lower-risk and consistent with this
codebase's existing posture: `imap.rs` already hand-rolls that same
TCP/TLS layer underneath `async-imap`'s protocol logic.

**POP3S (port 995, implicit TLS) only — no STARTTLS, no plaintext port
110.** This codebase has no insecure-connection path anywhere else
(`backend-backlog.md` calls this out explicitly for the rest of the
stack); adding plaintext POP3 would be the first exception. Implicit TLS
is also what both the real test mailbox and GreenMail's `pop3s` mode
offer directly, so there was no need for a STARTTLS branch the way
`smtp.rs` has one.

## Protocol layer

`Pop3Session` wraps a `tokio::io::BufReader<TlsStream<TcpStream>>`.
Reading is byte-oriented (`read_raw_line` uses `read_until(b'\n', ...)`,
not a UTF-8-validating line reader) because a `RETR`/`TOP` response
carries the contents of a real email, and nothing about POP3 guarantees
that's valid UTF-8 — the same reason `imap.rs`'s `BODY[]` fetch hands
`mail_parser` raw bytes rather than assuming text. `+OK`/`-ERR` status
lines and `LIST`/`UIDL` data are ASCII by protocol, so those are decoded
with a lossy UTF-8 conversion afterward, which is lossless in practice.

`unstuff_multiline_response` undoes the byte-stuffing rule and has a
plain unit test with no socket involved, same testability split as
`imap.rs::decode_header_text`.

## Commands

- **`list_messages(account_id, host, port)`** — `LIST` for message
  numbers + sizes, then `UIDL` once for the whole mailbox (optional per
  RFC 1939; a `-ERR` here just leaves every summary's `uidl` as `None`,
  not a hard failure), then `TOP n 0` per message for header-only
  subject/from/date (also optional, same graceful-skip handling). Returns
  `Pop3MessageSummary` — deliberately its own type, not a reuse of
  `imap::MessageSummary`: POP3 has no flags, no `\Seen`, and no UID in
  IMAP's sense, so forcing IMAP's fields onto it would be misleading
  rather than genuine reuse.
- **`fetch_message(account_id, host, port, number)`** — `RETR n`, parsed
  via `imap::parse_message_body` (see reuse note below) into
  `imap::MessageBody` — reused as-is, since a POP3 `RETR` and an IMAP
  `BODY[]` are both just raw RFC 822 bytes with no protocol-specific
  difference once you have them. Also harvests contact candidates from
  the parsed message's From/To/Cc, same best-effort posture as the IMAP
  path's contact harvesting.
- **`pop3_fetch_attachment(account_id, host, port, number, attachment_index)`**
  — downloads one attachment's actual bytes (base64-encoded), by its
  `index` in `fetch_message`'s `attachments` list. `RETR`s the message
  again and hands the raw bytes to `imap::extract_attachment` — the same
  function the IMAP side uses, since once you have raw RFC 822 bytes
  there's no protocol-specific step left in pulling one MIME part's
  content out of them. Named `pop3_fetch_attachment`, not
  `fetch_attachment`, only because Tauri's command macro registers by bare
  function name in one crate-wide namespace and `imap::fetch_attachment`
  already claims that name — see `imap-core.md` for the actual design
  (re-fetch-and-reparse rather than a partial `RETR`, which POP3 has no
  mechanism for anyway).
- **`delete_message(account_id, host, port, number)`** — `DELE n` then
  `QUIT`. POP3 deletions are only committed by the server on a clean
  `QUIT` (RFC 1939 §6); a dropped connection without one aborts them, so
  this command drives the session to `QUIT` itself rather than relying
  on the connection just closing.

## Reuse from `imap.rs`

`imap::parse_message_body(raw: &[u8])` was extracted out of
`fetch_body_by_uid` specifically so `pop3.rs` could call the same
raw-bytes-to-`MessageBody`-plus-contacts logic instead of duplicating it.
This was a pure extraction — `fetch_body_by_uid`'s own behavior and
existing tests are unchanged, it just delegates to the shared function
after fetching the raw bytes over IMAP.

## What this doesn't do

- **No local cache integration.** `cache.rs`'s `cached_messages` table is
  keyed by `(account_id, folder, uid)`; POP3 has neither folders nor a
  stable UID model in that sense (message numbers aren't guaranteed
  stable across sessions on every server, and `UIDL` is optional).
  Forcing POP3 into that schema is a separate design problem, not solved
  here — POP3 stays a direct, session-oriented fetch.
- **Partial account-model integration.** A POP3 account can now be
  onboarded and persisted: `cache::AccountRecord` gained
  `incoming_protocol` (`"imap"`/`"pop3"`), `pop3_host`, and `pop3_port`,
  and `account::add_pop3_account` stores the credential, verifies it via
  `pop3::verify_login` (connect + login + `QUIT`), and persists the record
  with the `imap_*` columns left as empty placeholders. `update_account`
  also re-verifies a POP3 account over POP3 rather than IMAP. What's still
  *not* integrated: the POP3 mail commands (`list_messages`/`fetch_message`/
  `delete_message`) still take `host`/`port` from the caller rather than
  resolving them from the stored account, and `fetch_unified_inbox` skips
  POP3 accounts outright (it fans out over IMAP `INBOX`es; POP3 has no
  folder/UID model to merge in). Surfacing POP3 mail in the unified view
  is still the separate design problem noted above.
- **No APOP/SASL.** Plain `USER`/`PASS` only, matching IMAP's plain
  `LOGIN` and SMTP's plain `Credentials` elsewhere in this codebase —
  POP3S's transport encryption already covers what APOP's challenge-
  response was originally for.

## Verification

- Pure unit tests (`unstuff_multiline_response`, the `LIST`/`UIDL` line
  parsers, the `+OK`/`-ERR` status-line split) run in the default
  `cargo test` pass, no network involved.
- Local disposable test server: confirmed GreenMail standalone does
  support POP3S (`-Dgreenmail.setup.test.pop3s`, port 3995 by default,
  alongside the `imaps`/`smtp` flags already used in `imap-core.md`) —
  including `UIDL` and `TOP`, both exercised directly against the
  container while writing this. Three `#[ignore]`d tests:

  ```
  docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 -p 3995:3995 \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.setup.test.pop3s -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
    greenmail/standalone:2.1.0

  python3 - <<'EOF'
  import smtplib
  from email.mime.text import MIMEText
  from email.utils import formatdate

  msg = MIMEText("This is a test message body for Helix POP3 fetch testing.")
  msg["Subject"] = "Helix POP3 test message"
  msg["From"] = "Sender Name <sender@helix.test>"
  msg["To"] = "helix@helix.test"
  msg["Date"] = formatdate(localtime=True)

  with smtplib.SMTP("127.0.0.1", 3025, timeout=10) as smtp:
      smtp.sendmail("sender@helix.test", ["helix@helix.test"], msg.as_string())
  EOF

  cargo test pop3::tests::lists_a_real_message_from_a_local_test_server -- --ignored
  cargo test pop3::tests::fetches_a_real_message_body_from_a_local_test_server -- --ignored
  cargo test pop3::tests::deletes_a_real_message_from_a_local_test_server -- --ignored

  docker rm -f helix-test-greenmail
  ```

  `lists_a_real_message_from_a_local_test_server` and
  `fetches_a_real_message_body_from_a_local_test_server` are read-only
  and can run against the same seeded container in either order; run
  `deletes_a_real_message_from_a_local_test_server` last, since it
  removes the seeded message — the same "independent fixtures, not
  meant to accumulate shared state" convention `imap-core.md` already
  documents for its own GreenMail tests.

- Manual, real mailbox: `list_messages`/`fetch_message` were run once
  against the real test mailbox (port 995, per the gitignored `.env`)
  and confirmed real results, then the throwaway test was deleted, per
  the convention in `imap-core.md`/`account-onboarding.md`.
  `delete_message` was deliberately **not** exercised against the real
  mailbox — unlike the GreenMail container, that's a real account, and
  `mailbox-actions.md`'s own precedent for verifying a mutation against
  it used a disposable message created specifically for that purpose,
  not an existing real one. `DELE`'s commit-on-`QUIT` behavior is already
  proven by the GreenMail test above.
