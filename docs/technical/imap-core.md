# IMAP connection core

`src-tauri/src/imap.rs` exposes these Tauri commands:

- `list_folders(account_id, host, port)` — connects, authenticates, lists
  the account's folders
- `fetch_messages(account_id, host, port, folder, limit)` — connects,
  authenticates, and returns summaries (UID, subject, sender, date, seen
  flag) for the most recent `limit` messages in `folder`
- `fetch_message_body(account_id, host, port, folder, uid)` — connects,
  authenticates, and returns the parsed content (plain text, HTML,
  attachment metadata) of one specific message by UID
- `fetch_attachment(account_id, host, port, folder, uid, attachment_index)`
  — connects, authenticates, and returns one specific attachment's actual
  content (base64-encoded), by its `index` in `fetch_message_body`'s
  `attachments` list. See "Attachment content" below.
- `fetch_message_source(account_id, host, port, folder, uid)` — returns
  the raw RFC 822 bytes base64-encoded (EXAMINE path, no `\Seen` side
  effect), for displaying the raw message source in-app.
- `export_message_eml(account_id, host, port, folder, uid, path)` — same
  raw RFC 822 bytes written to a caller-supplied absolute file path via
  `std::fs::write`. The caller is responsible for determining the path
  (e.g., from a native save-file dialog). EML format is literally the raw
  RFC 822 bytes with no extra framing, so both commands share
  `fetch_raw_message_by_uid`.

These are the first slices of real protocol work — proof that we can
actually talk to a mail server, before building anything more elaborate
on top.

## Attachment content

`fetch_message_body` only ever returns attachment *metadata*
(filename/content type/size) — fetching every attachment's bytes just to
show a message preview would waste bandwidth on attachments nobody asked
to download. `fetch_attachment` is the separate command for actually
downloading one: it re-fetches the message's raw bytes (`fetch_raw_message_by_uid`,
the same SELECT + `UID FETCH BODY[]` `fetch_body_by_uid` already does) and
hands them to `extract_attachment`, which re-parses and pulls out the part
at `attachment_index` via `mail_parser::MessagePart::contents()` (already
decoded — base64/quoted-printable is undone by the parser, not by us).

This re-fetches and re-parses the *entire* message rather than asking IMAP
for just the one MIME part via `BODY[<section>]`. That would save bandwidth
on large messages with large attachments, but requires mapping
`mail_parser`'s attachment ordering to IMAP's own section-number scheme,
which isn't implemented — not worth the complexity until a concrete case
(very large attachments) makes the cost of the current approach real.

The `index` field on `AttachmentInfo` (returned by `fetch_message_body`) is
what a caller passes back as `attachment_index` — it's just the position
in `mail_parser::Message::attachments()`'s iteration order, which is
deterministic for the same raw bytes, so it stays valid across the two
separate fetches as long as the message itself hasn't changed in between.

Content comes back as `content_base64`, a base64-encoded `String`, not a
raw `Vec<u8>` — Tauri's IPC goes through JSON, where serde would otherwise
turn a `Vec<u8>` into a JSON array of numbers, far larger over the wire
than a base64 string of the same bytes.

`pop3::pop3_fetch_attachment` is the POP3 equivalent, reusing
`extract_attachment` directly (it's protocol-agnostic — once you have an
email's raw bytes, there's no IMAP/POP3-specific step left) — see
`pop3.md`. Attachment bytes still aren't written to the local cache
(`cache.rs`'s schema has no content column for them) — that's a separate,
still-open backlog item, not solved by this.

## Recipient and threading headers (reply/forward composition)

`fetch_message_body`/POP3's `fetch_message` used to expose none of a
message's own From/To/Cc or threading headers — `MessageBody` was purely
about *content* (text/html/attachments). Resolving who a Reply/Reply-All
should go to, and threading a reply correctly, both need the original
message's headers too, so `MessageBody` gained:

- `from: Option<String>`, `to: Vec<String>`, `cc: Vec<String>`,
  `reply_to: Option<String>` — formatted `"Name <email>"` strings (same
  convention as `MessageSummary.from`), straight off the parsed
  `mail_parser::Message`. A real Reply should prefer `reply_to` over
  `from` when present (that's the entire point of the header existing),
  and Reply-All's Cc list is `to + cc` minus whichever address is the
  user's own account — both of those decisions belong to whatever
  composes the reply, not to this struct, which just reports what the
  message actually said.
- `message_id: Option<String>`, `in_reply_to: Option<String>`,
  `references: Vec<String>` — this message's own threading headers
  (angle brackets stripped, matching `mail_parser`'s own parsing). A
  reply to *this* message should send `in_reply_to: message_id` and
  `references: references + [message_id]` (RFC 5322 section 3.6.4) to
  `smtp::send_message` — see `smtp.md`. `in_reply_to`/`references` here
  describe whether *this* message is itself a reply; they're not
  consulted by anything in this codebase yet but are exactly the
  groundwork message threading (grouping by these same three headers)
  will need next, which is why they're parsed once, here, rather than
  bolted on twice.

`References`/`In-Reply-To`/`Message-ID` parse to `mail_parser`'s
`HeaderValue::Text` when there's exactly one ID or `HeaderValue::TextList`
for more than one (`header_value_to_id_list` collapses both into one
`Vec`) — a single-reference fixture wouldn't have caught a caller that
only handled the `Text` case, which is why
`parse_message_body_extracts_recipients_and_threading_headers`'s test
fixture deliberately uses a two-ID `References` chain.

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

### Implicit TLS vs. STARTTLS

`connect_and_login` takes a `use_starttls` flag, mirroring `smtp.rs`:

- **`false` — implicit TLS (IMAPS, port 993):** TLS from the first byte,
  the original behavior.
- **`true` — STARTTLS (port 143):** connect in plaintext, issue
  `STARTTLS` (`async-imap`'s `Client::run_command_and_check_ok` then
  `into_inner()` to recover the raw socket), upgrade *that same socket* to
  TLS via the same `tokio-native-tls` connector, then build a fresh client
  over the TLS stream and log in. The upgrade is mandatory — a server that
  won't `STARTTLS` is an error, never a plaintext fallback, the same
  no-downgradable-path posture as SMTP/POP3 here. Relevant because
  custom-domain/hosting mail servers commonly run STARTTLS on 143 rather
  than implicit TLS on 993.

The flag is a per-account property (`AccountRecord.imap_use_starttls`, see
`multi-account.md`), not a per-command argument. The data commands resolve
it from the cached account via `login_for_account`, so their signatures
are unchanged; only onboarding/verification passes it explicitly (via
`verify_and_list_folders`), because the account isn't persisted yet at
verify time. Either path yields the same `Session<TlsStream<TcpStream>>`,
so the rest of the module is oblivious to which transport got it there.

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

**Recipient/threading header extraction.**
`parse_message_body_extracts_recipients_and_threading_headers` (no network)
hand-builds a reply-shaped raw message -- multiple To/Cc recipients, a
`Reply-To` distinct from `From`, and a two-ID `References` chain -- and
confirms `parse_message_body` extracts every new `MessageBody` field
correctly, including the multi-ID `TextList` case a single-reference
fixture wouldn't exercise. `parses_a_multipart_message_with_attachment_from_a_local_test_server`
(`#[ignore]`, real GreenMail) also asserts `from`/`to` against the real
seeded message, alongside its existing attachment assertions.

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
`parses_a_multipart_message_with_attachment_from_a_local_test_server` and
`fetches_an_attachment_from_a_local_test_server` exercise `fetch_body_by_uid`
and `extract_attachment` respectively against a real multipart message
(plain text + HTML + a PDF attachment) on a fresh GreenMail container,
seeded with this instead of the plain-text message above. Both are
read-only and can run against the same seeded container in either order:

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
