# IMAP connection core

`src-tauri/src/imap.rs` exposes three Tauri commands:

- `list_folders(account_id, host, port)` — connects, authenticates, lists
  the account's folders
- `fetch_messages(account_id, host, port, folder, limit)` — connects,
  authenticates, and returns summaries (UID, subject, sender, date, seen
  flag) for the most recent `limit` messages in `folder`
- `fetch_message_body(account_id, host, port, folder, uid)` — connects,
  authenticates, and returns the parsed content (plain text, HTML,
  attachment metadata) of one specific message by UID

These are the first slices of real protocol work — proof that we can
actually talk to a mail server, before building anything more elaborate
on top.

## How it's wired

- TCP connection via `tokio::net::TcpStream`
- TLS via `tokio-native-tls` (wraps the OS's native TLS library —
  OpenSSL on Linux, Secure Transport on macOS, SChannel on Windows — same
  approach as credential storage: lean on the OS rather than vendoring
  our own crypto stack)
- IMAP protocol handling via `async-imap`, built with the `runtime-tokio`
  feature so it shares Tauri's existing Tokio runtime instead of running
  a second async runtime side by side
- Envelope/address types come from `imap-proto` directly (the same crate
  version `async-imap` depends on internally) since `async-imap` doesn't
  re-export them
- MIME parsing (for message bodies) via `mail-parser`, which takes the
  raw `BODY[]` bytes IMAP gives us and turns them into a structured
  message with decoded text/HTML parts and attachment metadata

All three commands share a `connect_and_login` helper for the TCP+TLS+LOGIN
setup, wrapped by `login_with_stored_credential`, which resolves the
password from the OS keychain (see below) before calling it. No
connection pooling or persistent session yet — each call opens and closes
its own connection. That's deliberately out of scope until there's a real
need for a long-lived session (e.g. IDLE-based live updates).

## fetch_messages details

- Opens the folder with `EXAMINE`, not `SELECT` — this is a preview-only
  read, and `EXAMINE` guarantees it can't mark anything as seen or
  otherwise mutate mailbox state as a side effect of just looking.
- Fetches `(UID FLAGS ENVELOPE INTERNALDATE)` for the most recent `limit`
  messages by sequence number (`exists - limit + 1 : exists`), not by
  date — IMAP sequence numbers are positional, not chronological, but for
  a normal mailbox the highest sequence numbers are the newest messages.
- Subject and sender display names are decoded with `decode_header_text`,
  which handles RFC 2047 encoded words (e.g. `=?UTF-8?B?...?=` for
  non-ASCII subjects), falling back to plain UTF-8 if a header is
  malformed. Address mailbox/host parts use plain `decode_lossy` instead —
  those are restricted to ASCII by the mail protocols involved, so there's
  no encoded-word syntax to look for there.

## fetch_message_body details

- Opens the folder with `SELECT`, not `EXAMINE` — unlike `fetch_messages`,
  this represents the user actually opening a specific message to read
  it, so fetching `BODY[]` is expected to mark it `\Seen`, same as any
  normal mail client. (`fetch_messages` deliberately doesn't do this,
  since just showing up in a list shouldn't count as reading something.)
- Looks the message up by UID (`uid_fetch`), not sequence number — UIDs
  are stable identifiers; sequence numbers shift as the mailbox changes,
  so they're the wrong thing to hold onto between a list view and an
  "open this message" action.
- Fetches the entire raw message (`BODY[]`) and hands it to
  `mail_parser::MessageParser`, which does the actual MIME decoding:
  multipart walking, charset conversion, content-transfer-encoding
  (base64/quoted-printable). We don't reimplement any of that ourselves.
- Returns the first plain-text body part and the first HTML body part
  (`body_text(0)` / `body_html(0)`) — most messages only have one of
  each; multipart/alternative messages have both and the frontend can
  pick which to render.
- Attachments are metadata only (filename, content type, size) — their
  bytes aren't fetched or returned. Downloading a specific attachment's
  content is a separate concern for later, not bundled into "open this
  message."

## Credential handling

`account_id` doubles as the IMAP/SMTP login username — accounts are
identified by their email address, and that's what mail servers expect
as the username too, so there's no separate username field.

`login_with_stored_credential` looks up the password via
`credentials::get_credential(account_id)`, uses it to log in, then calls
`.zeroize()` on the local `String` immediately after — success or
failure — so the plaintext password doesn't linger in process memory any
longer than the single `login()` call needs it for. The frontend never
sees or passes a raw password to these commands; it only ever supplies
`account_id`, which must have already been stored once via
`store_credential` (e.g. during account onboarding).

## Verification

**Header decoding.** Four plain unit tests (no network needed) cover
`decode_header_text` and `format_address`: a real RFC 2047 base64-encoded
word decodes correctly, plain ASCII passes through unchanged, malformed
encoded-word syntax falls back instead of failing, and a decoded display
name flows through into the formatted `"Name <user@host>"` string.

There's no committed test mailbox account, so the rest of the
verification leans on three kinds of check:

**Real external server, login-failure path, through the keychain.** Two
`#[ignore]`d tests (`connects_and_handshakes_with_a_real_imap_server`,
`fetch_messages_also_fails_at_the_login_step_without_real_credentials`)
store a throwaway credential via `credentials::store_credential`, call
`list_folders`/`fetch_messages` with just the `account_id`, and assert the
result is an IMAP-level login rejection from `imap.gmail.com:993` — not a
network/TLS error and not a keychain lookup error. This proves the
keychain-lookup wiring (`login_with_stored_credential`) and the
TCP/TLS/protocol-framing stack both work, though it never reaches the
EXAMINE/FETCH code since login fails first. Each test deletes its
credential afterward.

**Local disposable test server, full fetch path.** The
EXAMINE/FETCH/envelope-decoding logic is only actually exercised by
`parses_a_real_message_from_a_local_test_server`, which talks to a local
[GreenMail](https://greenmail-mail-test.github.io/greenmail/) container.
This test builds its own session directly (see below) rather than going
through credential storage, since it's about exercising the
EXAMINE/FETCH/decoding logic, not the keychain wiring. To run it:

```
docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
  greenmail/standalone:2.1.0

python3 - <<'EOF'
import smtplib
from email.mime.text import MIMEText
from email.utils import formatdate

msg = MIMEText("This is a test message body for Helix IMAP fetch testing.")
msg["Subject"] = "Helix test message"
msg["From"] = "Sender Name <sender@helix.test>"
msg["To"] = "helix@helix.test"
msg["Date"] = formatdate(localtime=True)

with smtplib.SMTP("127.0.0.1", 3025, timeout=10) as smtp:
    smtp.sendmail("sender@helix.test", ["helix@helix.test"], msg.as_string())
EOF

cargo test -- --ignored

docker rm -f helix-test-greenmail
```

**Local disposable test server, full message-body path.**
`parses_a_multipart_message_with_attachment_from_a_local_test_server`
exercises `fetch_body_by_uid` against a real multipart message (plain
text + HTML + a PDF attachment) on a fresh GreenMail container, seeded
with this instead of the plain-text message above:

```
docker run -d --name helix-test-greenmail -p 3993:3993 -p 3025:3025 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.users=helix:helixpass@helix.test -Dgreenmail.hostname=0.0.0.0' \
  greenmail/standalone:2.1.0

python3 - <<'EOF'
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from email.utils import formatdate

msg = MIMEMultipart("mixed")
msg["Subject"] = "Helix multipart test message"
msg["From"] = "Sender Name <sender@helix.test>"
msg["To"] = "helix@helix.test"
msg["Date"] = formatdate(localtime=True)

alt = MIMEMultipart("alternative")
alt.attach(MIMEText("This is the plain text body.", "plain"))
alt.attach(MIMEText("<p>This is the <b>HTML</b> body.</p>", "html"))
msg.attach(alt)

attachment = MIMEApplication(b"fake pdf bytes here", _subtype="pdf")
attachment.add_header("Content-Disposition", "attachment", filename="document.pdf")
msg.attach(attachment)

with smtplib.SMTP("127.0.0.1", 3025, timeout=10) as smtp:
    smtp.sendmail("sender@helix.test", ["helix@helix.test"], msg.as_string())
EOF

cargo test -- --ignored

docker rm -f helix-test-greenmail
```

This and the plain-text fetch test are written as independent fixtures
(each assumes a fresh container seeded with exactly one specific
message as UID 1) rather than something meant to run together against
shared, accumulating container state.

**Real professional mail host, manual check.** Both commands were also
manually verified against a real account on a real hosting provider
(not a mock) — 7 real folders listed, 5 real messages fetched and parsed
correctly. That check used a scratch test reading credentials from env
vars, deleted immediately after use; it isn't part of the committed test
suite since other contributors won't have access to that account. If you
have access to a real mailbox locally (e.g. via a gitignored `.env`),
the same approach works: write a throwaway `#[ignore]`d test that reads
`std::env::var(...)` for host/account_id/password, store the credential,
call the command, assert, delete the credential, then remove the test
again — never commit one person's real mailbox credentials.

GreenMail's certificate is self-signed, so this test builds its own
permissive TLS connector rather than going through `connect_and_login` —
production code keeps validating certificates normally; only the test
fixture's connector is relaxed.

All of these are excluded from the default `cargo test` run since they
depend on either outbound network access to a specific external server,
or a local Docker container that isn't part of the normal dev setup.
