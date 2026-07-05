# SMTP sending

`src-tauri/src/smtp.rs` exposes `send_message(account_id, host, port,
use_starttls, to, cc, bcc, subject, body, html, attachments, in_reply_to,
references, encrypt)`. Same conventions as the IMAP layer:

- `account_id` doubles as both the SMTP login username and the message's
  From address
- `to`/`cc`/`bcc` are each a comma-separated address list (`"a@x, Name
  <b@y>"`), parsed via `parse_address_list`, which reuses lettre's own
  `Mailboxes` parser so display names and quoting are handled consistently.
  An empty/whitespace string means "none" (Cc/Bcc are optional; To must
  have at least one address). Each parsed mailbox is added with the
  builder's `.to()`/`.cc()`/`.bcc()`, which *append* (lettre's `mailbox()`
  joins rather than replaces), so multiple recipients land in one header
  each rather than the last-write-wins single-mailbox behaviour the old
  single `to.parse::<Mailbox>()` had. Bcc recipients still receive the
  message — lettre uses the Bcc header to build the SMTP envelope — but it's
  stripped from the visible headers by default, which is the privacy point
  of Bcc. Every recipient across all three fields is harvested into the
  contact cache (sending to someone is a real correspondence signal). PGP
  `encrypt` is single-recipient inline-armored only, so combining it with
  Cc/Bcc or more than one To address is a clean upfront error, the same
  posture as the html/attachments guard below.
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
- HTML body and attachments are both supported now — see "Outgoing
  multipart mail" below. A plain `body` is still always required and
  always sent: `send_message` never sends HTML-only mail, even when
  `html` is supplied.

## Outgoing multipart mail

`html: Option<String>` and `attachments: Vec<OutgoingAttachment>`
(`{ filename, content_type, content_base64 }`, the same base64-over-IPC
convention `imap::AttachmentContent` uses for *downloaded* attachments —
see `imap-core.md`) let a caller build a real multipart MIME message
instead of the single `TEXT_PLAIN` body this command used to always send.

`build_multipart_body` is the actual construction, via `lettre`'s
`message::{MultiPart, SinglePart, Attachment}`:

- No `html`, no attachments → unchanged, single `TEXT_PLAIN` body.
- `html` present → `MultiPart::mixed()` wrapping a
  `MultiPart::alternative_plain_html(text, html)` — `text` is always
  included alongside `html`, not replaced by it. A plain-text fallback
  part is standard practice for HTML mail (some clients/spam filters treat
  HTML-only mail with suspicion), and the receiving side of this codebase
  already expects both to coexist (`imap::MessageBody` has separate
  `text`/`html` fields) — sending only one would be an asymmetric
  half-feature relative to what fetching already supports.
- `attachments` present → one `SinglePart` per attachment (via
  `Attachment::new(filename).body(bytes, content_type)`), added to the
  same `MultiPart::mixed()` alongside whichever of the two cases above
  applies.

### Encryption and multipart don't mix

`encrypt: true` together with `html.is_some()` or a non-empty
`attachments` is a hard, upfront error — not a best-effort skip. PGP
support in this codebase is inline-armored plain-text only (see `pgp.md`);
encrypting a message that also carries an HTML body or attachments would
mean either silently encrypting only the plain-text part, or silently
sending the rest unencrypted. Both are the kind of quiet security gap this
codebase's existing `encrypt` hard-fail posture (see `pgp.md`) exists to
prevent, so this is the same posture applied to a new case, not a new rule.

## Reply/forward threading headers

`in_reply_to: Option<String>` and `references: Vec<String>` let a caller
make a sent message actually thread as a reply in a real mail client
(Gmail/Outlook/Apple Mail group by these headers, not just by matching
subjects) -- previously `send_message` had no way to set either at all,
so a "reply" sent through it was indistinguishable from a brand new
message to whatever email client received it.

Both are set verbatim via `lettre::message::header::{InReplyTo,
References}`, wrapped in the `<...>` angle brackets RFC 5322 expects on
the wire (`mail_parser` strips them on the way back in -- see
`imap::MessageBody`/`imap-core.md` -- so a value read off one message and
passed back in here round-trips through the same bare-ID format both
times). Building the right values is entirely the caller's job:

- `in_reply_to` should be the original message's own `message_id`
  (`imap::MessageBody.message_id`).
- `references` should be the original message's own `references` with
  its `message_id` appended (RFC 5322 section 3.6.4) -- not just
  `[message_id]` on its own, or a long reply chain degrades into a series
  of two-message threads instead of one real thread.

`send_message` doesn't validate either against the other, or against
anything else -- it has no way to know what message an arbitrary ID is
supposed to refer to, so it just sets whatever header values it's given.
Recipient resolution (who Reply/Reply-All should actually send to) is a
separate, frontend-side concern once wired -- see `imap-core.md`'s
"Recipient and threading headers" section for the data this is built on
top of, and `subject`'s own `Re:`/`Fwd:` prefixing, which stays exactly
where it already was: composed by whoever calls `send_message`, not done
here.

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
- `sends_an_html_message_with_an_attachment_and_lands_it_on_a_local_test_server`
  (`#[ignore]`, same GreenMail container/command as above): calls
  `build_multipart_body` directly (the real function `send_message` uses),
  sends it over the same permissive-TLS mailer, then reads it back two
  ways — `imap::fetch_body_by_uid` for the text/html parts,
  `imap::extract_attachment` (via `imap::fetch_raw_message_by_uid`) for
  the attachment's actual bytes — confirming the full round trip rather
  than just that constructing the MIME structure didn't panic.
- `sends_a_reply_with_threading_headers_and_lands_it_on_a_local_test_server`
  (`#[ignore]`, same GreenMail container/command as above): sends an
  "original" message with an explicit `Message-ID`, then a "reply" with
  `In-Reply-To`/`References` pointed at it (replicating the header-setting
  code directly, same reason every GreenMail test in this file bypasses
  `send_message` itself), then reads the reply back over IMAP and
  confirms `imap::MessageBody.in_reply_to`/`references` come back exactly
  as sent — proving the `<...>` header formatting and `mail_parser`'s
  stripping of it round-trip correctly together, not just that setting
  the headers didn't error.
- Manually checked against the real professional mail host too (see
  finding above) — that attempt correctly failed at the TLS layer due to
  that host's own certificate mismatch, which is itself a useful
  confirmation that certificate validation is actually being enforced.

## Saving sent mail to the Sent folder

After a successful SMTP delivery, `send_message` best-effort APPENDs the
same RFC 822 bytes it just sent to the account's configured IMAP Sent
folder. The mechanism:

1. `lettre::Message::formatted(&self) -> Vec<u8>` is called on the built
   message *before* handing it to the transport. `formatted()` borrows
   `self`, so the move into `mailer.send()` happens after we already have
   the raw bytes. BCC recipients are part of the SMTP envelope but RFC 5322
   requires them stripped from the message headers — lettre does this
   automatically, so the stored copy is correct and no BCC address leaks
   into the Sent folder copy.
2. `append_to_sent(account_id, &raw_bytes)` opens an IMAP session via
   `imap::login_for_account` (same session pattern as drafts), APPENDs
   with the `\Seen` flag (so the Sent copy doesn't show as unread), then
   logs out.
3. For POP3 accounts (`imap_host` is empty), the APPEND is skipped — there
   is no IMAP server to save to.
4. Any error in the APPEND is logged at `warn` level and discarded — a
   Sent-folder write failure never surfaces to the caller or the user.

`sent_folder` is now a field on `AccountRecord` (default `"Sent"`) and an
optional `sent_folder` parameter on `add_account`. The additive migration
`ALTER TABLE accounts ADD COLUMN sent_folder TEXT NOT NULL DEFAULT 'Sent'`
updates existing databases. `update_account` preserves the existing
`sent_folder` the same way it already preserved `archive_folder`,
`trash_folder`, `drafts_folder`, and `spam_folder`.

## Sent-folder self-heal in append_to_sent (added later)

`append_to_sent` used to APPEND to whatever `sent_folder` the account
record held and log the failure -- which, for records created with the
old hardcoded "Sent" default on a nested-layout server (`INBOX.Sent`),
meant every sent message silently never reached the Sent folder. On an
APPEND failure it now LISTs folders in the same session, resolves the
real sent folder via `imap::resolve_equivalent_folder`, retries the
APPEND there, and persists the corrected name to the account record
(`imap::persist_folder_correction`) so the next send goes straight to the
right place. Still best-effort overall: a Sent-folder failure never
blocks the send itself.
