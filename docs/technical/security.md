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
  (`account::update_account`). The real-keychain round-trip test proves
  this against whichever OS credential store the test happens to run on;
  there's no CI yet running it against all three, so today that's
  verified on Linux and only spot-checked (not continuously) on macOS/
  Windows. See `credential-storage.md`.
- **The local mail cache is encrypted at rest.** SQLCipher via `rusqlite`'s
  `bundled-sqlcipher` feature; the encryption key itself is a random
  32-byte value stored in the OS keychain, not derived from anything
  guessable. See `local-cache.md`.
- **The bulk account-import file is treated as a secret, not as config.**
  It's the one place a plaintext password legitimately sits on disk (the
  user wrote it there), so `account_import.rs` minimizes its lifetime:
  the file is read once, the in-memory copy is zeroized right after
  parsing, each parsed password is zeroized after its account imports
  (through the same keychain-verify-or-roll-back path as the onboarding
  form), and the file itself is overwritten with zeros, fsynced, and
  deleted after the run. It survives only a parse error -- nothing was
  imported, and silently deleting the user's typing over a typo would
  be worse -- and the error message says the passwords are still on
  disk. The overwrite is best-effort scrubbing (journaling/SSD caveats
  in `account-import-file.md`), and a filled-in `accounts-import.txt`
  is gitignored so it can't be committed. See `account-import-file.md`.
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
  `dangerousDisableAssetCspModification` is set to `["style-src"]` -- and
  ONLY `style-src`, on purpose. At package time Tauri v2 rewrites the CSP
  to inject per-asset `nonce-`/hash sources; per the CSP spec, once a nonce
  appears in a directive the browser *ignores* `'unsafe-inline'` for it.
  react-native-web injects all its layout styles as un-nonced `<style>`
  elements at runtime, so a nonce'd `style-src` blocks every one of them --
  the app renders as unstyled text (WebKitGTK logs "Refused to apply a
  stylesheet ... 'unsafe-inline' does not appear in the style-src
  directive"). This only bites the packaged build, not `tauri dev`, which
  is why it was easy to miss. Excluding `style-src` from Tauri's rewrite
  keeps our `'unsafe-inline'` effective for the CSS-in-JS. **Do not** widen
  this to disable script-src modification or set the whole option to `true`:
  script execution is the real XSS vector and keeps Tauri's nonce lock;
  inline *styles* are already allowed by design, and received-mail HTML is
  independently sanitized by DOMPurify (which also strips remote `url()`),
  so `'unsafe-inline'` on style-src is not a new exposure.
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
  one request, and access tokens are held in memory only. Removing an
  OAuth account (or rolling back a failed OAuth onboarding) also revokes
  the grant at the provider (RFC 7009, best-effort, Google only --
  Microsoft has no revocation endpoint), so no live refresh token
  outlives its local record.

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

### 2026-07-06 follow-up: WKD key auto-import could overwrite a trusted key

A review of the branch's PGP additions found the compose/encrypt flow's
opportunistic WKD lookup unsafe against key substitution. When the user
enabled encryption for a recipient, `ComposeModal` called
`discover_pgp_key_wkd` and then `import_contact_key` with no guard --
and `cache::upsert_contact_key` is an `ON CONFLICT(email) DO UPDATE`
upsert. So whatever key a recipient's domain currently served over WKD
would **silently replace** a key the user had previously imported and
verified out-of-band, with no confirmation and no visible change. That is
a downgrade path: a compromised or hostile WKD endpoint (or a MITM on a
domain without proper key pinning) could swap in its own key for a contact
the user trusts, and subsequent mail to that contact would encrypt to the
attacker.

Fixed by adding `pgp::ensure_contact_key_wkd`, a no-overwrite acquisition
path that keeps any key already on file (returning it untouched) and only
fetches-and-imports when nothing is stored -- the same rule
`harvest_autocrypt` already applies to inbound Autocrypt headers, since
both are keys the user never individually confirmed. The compose flow now
uses it; `import_contact_key` stays the explicit, overwrite-capable path
behind the key-management UI, where replacing a key is a deliberate user
action. (As a bonus, the old code marked a recipient "found" even when the
fire-and-forget import failed; the new path only reports success once a key
is actually present.) See `pgp.md`'s WKD section.

### 2026-07-06 follow-up: OAuth credential-blob misuse audit

After OAuth landed, a sweep of every `get_credential` consumer looked for
code paths that still assume the keychain secret is a plain password --
the failure mode being an OAuth account's refresh-token blob (a durable
full-mail-access secret) transmitted somewhere as if it were one. Three
findings, all fixed:

- **`ics::respond_to_invite` built its own SMTP transport** with the raw
  secret as a PLAIN password -- it predates OAuth and never got migrated.
  For an OAuth account the invite reply both failed to authenticate and
  sent the refresh-token blob to the SMTP server inside the AUTH exchange.
  Fixed by routing it through `smtp::transport_credentials` (now
  `pub(crate)`), the same access-token + pinned-XOAUTH2 path
  `send_message` uses; that helper's doc comment now names this rule.
- **The CalDAV/CardDAV credential heal could leak the blob to a DAV
  server.** `resolve_source_password`'s fallback re-uses the owning
  account's mail credential when a source's own keychain entry has gone
  missing; for an OAuth account that would send the blob as Basic auth to
  whatever host the source URL names (potentially a third party, since
  DAV servers are often not the mail server). Both modules now refuse the
  fallback for a blob-shaped credential with an error telling the user to
  re-add the source with its own password.
- **`update_account` accepted a "password rotation" for OAuth accounts**,
  which would overwrite the token blob with a plain password while
  `auth_method` still claimed oauth2. The verify step would have caught it
  after the fact; now it's rejected upfront with a pointer to "Sign in
  again". (The settings UI already hides the password field for OAuth
  accounts -- the guard covers every other caller.)

Everything else that authenticates -- `imap.rs`, `smtp.rs`, `pop3.rs`,
`drafts.rs`, `idle.rs`, the unified inbox -- already went through the
OAuth-aware helpers (`login_with_stored_credential` /
`transport_credentials`); those two helpers are the only correct entry
points, and any new code that opens an authenticated connection must use
them.

### 2026-07-06 follow-up: attachment filenames reaching the filesystem

Attachment downloads now write real files into the OS Downloads folder via
the `save_to_downloads` command (`files.rs`) instead of the webview's
anchor-download path. The filename comes from the mail's MIME headers,
i.e. attacker-controlled: a crafted `filename="../../.bashrc"` (or one
with `\`, `:`, control characters, or a leading dot) must not be able to
escape the Downloads directory, overwrite dotfiles, or hide itself.
`sanitize_filename` strips path separators and control characters and
trims leading/trailing dots and whitespace, falling back to `attachment`
when nothing survives; `unique_path` then de-duplicates browser-style
(" (1)") so a repeated download can't overwrite an earlier file either.
Both are unit-tested. The command runs on the blocking pool like every
other filesystem-touching command (see architecture.md).

### 2026-07-06 follow-up: app CSP vs. opt-in remote images

The packaged app's CSP had `img-src 'self' data: blob: asset:` -- no
remote hosts. A `srcdoc` iframe inherits the embedding document's CSP,
and the message iframe's own `<meta>` CSP can only tighten the inherited
policy, never loosen it, so in production builds "Show images" (both
"just this time" and "always from domain") silently did nothing: the
remote fetches were blocked a layer above the message sandbox. Dev builds
have no injected CSP, which is why the feature worked there and the gap
shipped unnoticed.

Fix: the app-level `img-src` now includes `https:` and `http:`. The
tracking-protection guarantee never lived in the app CSP -- it lives in
`sanitizeHtml` (remote `src` attributes are moved to `data-blocked-src`
while blocking is on) plus the per-message iframe CSP, which stays at
`img-src data: blob:` until the user opts in. The app chrome itself never
renders attacker-controlled image URLs outside that sandboxed iframe, so
broadening the app policy doesn't reopen the tracking-pixel hole the
2026-06-27 review closed; it just lets the user's explicit opt-in
actually take effect. Script/connect/font sources are unchanged.

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
