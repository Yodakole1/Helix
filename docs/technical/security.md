# Security posture

This doc collects the properties Helix's "secure" claim actually rests on,
plus the record of security reviews run against the codebase and what they
found. It's meant to be checkable, not marketing copy -- every item below
names the file that enforces it.

## Baseline properties (enforced in code, not just documented intent)

- **No plaintext connection path exists, anywhere.** IMAP (`imap.rs`),
  POP3 (`pop3.rs`), and SMTP (`smtp.rs`) all require either implicit TLS or
  a mandatory STARTTLS upgrade before any credential is sent; none of the
  three has a fallback that continues in plaintext if the upgrade fails.
  POP3 in particular is POP3S-only -- no STARTTLS/plaintext option was
  ever added for it. See `imap-core.md`, `pop3.md`, `smtp.md`.
- **Credentials never touch app storage, on any of the three OSes Helix
  targets.** `credentials.rs` wraps the OS's own credential store --
  Secret Service on Linux, Keychain Services on macOS, Credential Manager
  on Windows -- via the `keyring` crate, with the backend chosen per
  target in `Cargo.toml` so the exact same source code runs against
  whichever one is correct for the platform. Passwords are zeroized
  (`zeroize` crate) immediately after every login attempt, success or
  failure, and after every credential-rotation path
  (`account::update_account`). This isn't just asserted: `.github/workflows/ci.yml`
  runs the real-keychain round-trip test against all three actual OS
  credential stores on every push. See `credential-storage.md`.
- **The local mail cache is encrypted at rest.** SQLCipher via `rusqlite`'s
  `bundled-sqlcipher` feature; the encryption key itself is a random
  32-byte value stored in the OS keychain, not derived from anything
  guessable. See `local-cache.md`.
- **CalDAV/CardDAV sync only trusts the origin the user configured.**
  `caldav.rs`/`carddav.rs`'s `resolve_href` rejects any server-reported
  resource href (or scheme-downgraded same-host href) that doesn't match
  the configured collection's origin, so a compromised or malicious DAV
  server can't redirect a background sync's Basic-Auth credentials to a
  third-party host.
- **Inline HTML compose escapes untrusted content before it reaches the
  DOM.** Reply/Reply-All/Forward prefill quoted text through `escapeHtml()`
  (`RichTextEditor.tsx`) before it's ever assigned to `innerHTML`, since a
  quoted message body is the *original sender's* content and therefore
  untrusted. Inbound HTML mail rendering (`ReaderPane`) goes through a
  separate allowlist sanitizer, `sanitizeHtml.ts` (DOMPurify-based), before
  render -- see `frontend-layout.md`.
- **PGP and S/MIME provide real end-to-end encryption for mail content**
  (`pgp.rs`, `smime.rs`), on top of transport-level TLS -- see `pgp.md`,
  `smime.md`.
- **Tauri's CSP is set, not disabled.** `src-tauri/tauri.conf.json`'s
  `csp` restricts script/style/connect sources rather than leaving CSP
  `null` (which would opt the webview out of it entirely).
- **The optional app lock stores a verifier, never the secret.** The lock
  password is Argon2id-hashed (random salt) with only the PHC hash kept in
  the OS keychain under a reserved sentinel name; the passkey path stores
  a FIDO2 credential id + public key and unlocks only on a verified
  fresh-challenge assertion signature, not on mere key presence. The lock
  is a UI access gate on top of (not instead of) the encrypted cache --
  see `app-lock.md` for the exact boundary.
- **No outbound tracking, by policy.** Helix strips/blocks remote images
  in received mail by default, and deliberately does not implement read
  receipts-by-default, tracking pixels, or link tracking on outgoing
  mail. Feature requests for "know when the recipient opened it" are
  declined as incompatible with the above.
- **Updates are signed, and checked only on request.** The update channel
  (`tauri-plugin-updater`, see `updater.md`) verifies every downloaded
  package against the minisign public key baked into the binary before
  installing -- the signature, not the TLS connection to GitHub, is the
  trust anchor, so a compromised release host can't push code. The
  private key lives outside the repository. Update checks are manual
  (Settings > About), consistent with the no-phone-home posture.
- **OAuth sign-in never sees the provider password.** Gmail/Microsoft 365
  accounts authenticate via OAuth2 in the *system browser* (`oauth.rs`,
  see `oauth.md`); Helix receives only scoped tokens. The refresh token
  is keychain-stored like a password would be, the authorization flow
  uses PKCE + a state check on a loopback listener that accepts exactly
  one request, and access tokens are held in memory only.

## Review history

### 2026-07-01 review (this branch)

Full review of the `backend-starttls-pop3-account-features` branch: the
committed commit plus the large uncommitted diff adding CalDAV, CardDAV,
S/MIME, the Bayesian spam classifier, ICS invites, identities, and thread
snoozing. Two High-severity findings, both fixed same-day:

- **Stored XSS in HTML-compose reply/forward.** `RichTextEditor` assigned
  `initialHtml` straight to `innerHTML` with no escaping; quoted
  reply/forward text is built from the original sender's `textBody` with
  no HTML-escaping either, so a sender's raw markup would execute in the
  compose webview the moment a user replied and switched to rich-text
  mode -- with `invoke()` access to every registered backend command.
  Fixed by escaping the quoted body (`escapeHtml()`) before it becomes
  `initialHtml`.
- **CalDAV/CardDAV credential leak via server-controlled URLs.**
  `resolve_href` accepted any absolute href a PROPFIND response returned
  and reattached the account's Basic-Auth credentials to it
  unconditionally, so a compromised or malicious DAV server could redirect
  a routine background sync's credentials to an arbitrary third-party
  host. Fixed by requiring the resolved href's origin (scheme + host +
  port) to match the configured collection's origin, rejecting (and
  skipping, with a log line) anything that doesn't.

One Low-severity finding, also fixed:

- **Old password not zeroized after a successful account update.**
  `account::update_account` kept the pre-rotation password around to
  support rollback on a failed re-verification, but dropped it without
  `.zeroize()` on the success path. Fixed to zeroize on every exit path.

### 2026-07-01 follow-up: draft MIME header interpolation

Targeted re-review of the STARTTLS/POP3/`update_account`/contacts/draft-
attachments commit (`a291bb4`). No High/Medium finding met the bar, but one
Low-severity hardening item was fixed:

- **Unescaped header interpolation in hand-built draft MIME.**
  `drafts::build_raw_draft_bytes` spliced `to`, `subject`, and each
  attachment's `filename`/`content_type` directly into raw header lines
  (unlike `smtp.rs`'s send path, which builds attachments through
  `lettre`'s `ContentType`/`Attachment`, which reject or encode unsafe
  values). A CR/LF in any of those fields could inject an extra header
  line into the locally-APPENDed Drafts message. Impact was confined to
  the same user's own Drafts folder and never reached the actual send
  path, so this didn't cross a privilege boundary -- fixed anyway as
  defense-in-depth via a new `strip_crlf` helper applied to all four
  fields, with a regression test
  (`crlf_in_to_subject_and_attachment_fields_cannot_inject_extra_headers`).

### 2026-07-05 follow-up: remaining draft header vectors

Re-audit of the same `build_raw_draft_bytes` found the earlier `strip_crlf`
pass had missed three header fields, two of which a *remote sender*
controls:

- **`In-Reply-To` and `References` were still interpolated raw.** On a
  reply these echo the original message's `Message-ID`/`References` headers
  -- attacker-controlled values -- so a CR/LF in a crafted `Message-ID`
  could inject an extra header line into the reply draft, the same class of
  bug as the attachment-filename vector but reachable without the user ever
  touching an attachment. `From` (the account's own address) was also
  unstripped. Fixed by routing all three through `strip_crlf`, with a
  dedicated regression test
  (`crlf_in_reply_headers_cannot_inject_extra_headers`). Impact remained
  confined to the user's own Drafts folder (length-counted IMAP `APPEND`
  literal, so no IMAP command injection), consistent with the prior
  finding's severity.

### 2026-06-27 review

Earlier full-codebase pass (see prior session notes): no exploitable
vulnerabilities found; a CSS tracking-pixel leak (remote `url()` in a
`style` attribute bypassing the image-blocking allowlist) was found and
fixed in `sanitizeHtml.ts`.

## Known, deliberate scope boundaries (not bugs)

- S/MIME signature verification is structural only (`NOVERIFY` on the
  trust-chain step) -- full certificate chain validation against a trust
  store is deferred, documented in `smime.md`.
- PGP and S/MIME are inline-armored / PKCS7 only, not PGP/MIME -- outgoing
  mail must be plain-text/non-multipart for either to apply. See `pgp.md`,
  `smime.md`.
- CalDAV/CardDAV discovery (`discover_caldav`/`discover_carddav`, as
  opposed to the recurring `sync_caldav`/`sync_carddav`) is a one-time,
  user-supervised action and is *not* origin-pinned the way sync is --
  RFC 6764 discovery legitimately can span hosts (principal on one host,
  calendar-home-set on another), and the user reviews the returned URLs
  before choosing one to add as a trusted source.
