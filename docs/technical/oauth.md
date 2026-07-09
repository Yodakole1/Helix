# OAuth2 (XOAUTH2) login

Gmail and Microsoft 365 are increasingly hostile to app passwords --
Google hides them behind 2FA setup and Microsoft has been retiring basic
auth outright. `src-tauri/src/oauth.rs` implements the modern path:
OAuth2 sign-in in the system browser, XOAUTH2 SASL on the wire.

## The flow (RFC 8252 native-app pattern)

`account::add_oauth_account` runs the whole thing in one command:

1. `oauth::run_authorization_flow` binds a one-shot HTTP listener on a
   random loopback port, generates a PKCE S256 verifier/challenge pair
   and a `state` nonce, and opens the provider's consent URL in the
   **system browser** (via the `open` crate -- Google blocks embedded
   webviews for sign-in, and the system browser is where the user's
   existing session and password manager live).
2. The provider redirects to `http://127.0.0.1:<port>/callback` (Google)
   or `http://localhost:<port>/callback` (Microsoft -- each provider's
   native-client rules want a different loopback host, so
   `ProviderConfig.redirect_host` carries it). The listener accepts
   exactly one request, verifies `state`, percent-decodes the
   authorization code, and serves a small "you can close this tab" page.
   A 5-minute timeout fails the flow cleanly if the user abandons it.
3. The code is exchanged at the token endpoint (with the PKCE verifier)
   for an access token and -- the part that matters -- a **refresh
   token**. A missing refresh token is a hard error, not a degraded
   success: without one the account would silently sign out when the
   access token expired.

## What gets stored, and how the protocols branch

The refresh token goes into the OS keychain as a JSON blob
(`StoredOauth`: a fixed `kind: "helix-oauth2"` marker plus provider,
client ID/secret, refresh token) under the **same `account_id` entry** a
password would use. The protocol modules branch on what the stored
secret *is*, not on a config flag: `imap::login_with_stored_credential`,
`pop3::login_with_stored_credential`, and `smtp::transport_credentials`
each fetch the secret once, try `oauth::parse_stored`, and take the
XOAUTH2 path on a match or the password path otherwise. That keeps every
existing call site working unchanged and means there is no way for the
flag and the secret to disagree. Everything else that authenticates rides
those helpers rather than reading the keychain itself -- `drafts.rs` and
`idle.rs` via `imap::login_for_account`, `ics.rs`'s invite replies via
`smtp::transport_credentials` -- see security.md's 2026-07-06 entry for
the audit that enforced this. (`accounts.auth_method` /
`accounts.oauth_provider` columns exist too, but only so the frontend
can render the right settings UI -- an OAuth account has no password to
rotate.)

Access tokens are never persisted. `oauth::access_token` keeps them in
an in-process map with their expiry; this matters because Helix opens a
fresh connection per command (see `architecture.md`), and without the
cache every folder listing would cost a token-endpoint round trip.
Microsoft rotates refresh tokens on every refresh -- a rotated token is
written back to the keychain immediately (best-effort with a logged
warning, since the old token stays valid until used).

On the wire:

- **IMAP**: `AUTHENTICATE XOAUTH2` via `async-imap`'s `Authenticator`
  trait. On failure the server sends a continuation with a base64 JSON
  error and expects an *empty* response before its final `NO`; the
  authenticator latches after the first response so it answers that
  continuation correctly instead of hanging the exchange.
- **SMTP**: `lettre`'s built-in `Mechanism::Xoauth2`, pinned as the only
  offered mechanism for OAuth accounts (offering PLAIN alongside would
  let the server pick a mechanism an access token can't satisfy).
- **POP3**: `AUTH XOAUTH2 <initial-response>` (RFC 5034) in the
  hand-rolled client, same error-continuation handling as IMAP.

## Client IDs

OAuth requires an app registration with each provider, and for a
desktop app the client ID (and Google's "desktop app" client secret) is
distributable but not committable-by-default. Resolution order:

1. A user-supplied client ID entered in the onboarding UI (kept in the
   keychain blob per account).
2. A compile-time default injected at build via environment variables:
   `HELIX_GMAIL_CLIENT_ID`, `HELIX_GMAIL_CLIENT_SECRET`,
   `HELIX_MICROSOFT_CLIENT_ID` (release builds should set these).
3. Otherwise a clear error telling the user to register one.

Registering:

- **Google**: Cloud Console > APIs & Services > Credentials > OAuth
  client ID, application type **Desktop app**. Add the
  `https://mail.google.com/` scope on the consent screen. Desktop-app
  clients get a client secret; it is required at token exchange even
  with PKCE (it is not actually secret in a native app -- Google says as
  much -- but the parameter is mandatory).
- **Microsoft**: Entra admin center > App registrations > New. Under
  Authentication add the **Mobile and desktop applications** platform
  with redirect URI `http://localhost`. API permissions: delegated
  `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`. Public client
  -- no secret.

## Onboarding and rollback

`add_oauth_account` follows `add_account`'s
store-verify-persist-or-roll-back discipline exactly: browser flow,
keychain write, then a real XOAUTH2 IMAP `LIST` to verify (which also
resolves the provider's special folders -- `[Gmail]/Sent Mail` etc. --
through the same `resolve_special_folder` path as password accounts),
then the account record. Any failure after the keychain write deletes
the credential and drops the cached access token, so a refresh token is
never left stored for an account that doesn't exist.

Hosts and ports come from the provider preset (`ProviderConfig`), not
from the user: these two providers' endpoints are fixed and public, and
asking for them would just be a chance to get them wrong.

The onboarding UI (AddAccountView) shows "Sign in with Google" /
"Sign in with Microsoft" buttons once an email address is entered. The
CalDAV/CardDAV probe step is skipped for OAuth accounts -- neither
provider offers password-DAV, so the checklist would always fail.

## Re-authorization (a dead refresh token is recoverable)

Refresh tokens die: the user revokes access from the provider's security
page, Microsoft expires them after long inactivity, Google invalidates
them on some password changes. `account::reauthorize_oauth_account`
makes that recoverable without losing the account -- it re-runs the same
browser flow for an *existing* account and follows `update_account`'s
rotate-verify-or-restore discipline: hold the old keychain blob aside,
store the fresh token set, verify with a real XOAUTH2 IMAP login, and on
failure restore the old blob (and drop the cached access token) so the
account is exactly as it was. The client ID/secret are reused from the
stored blob -- they're what worked at onboarding -- with the compiled-in
default as fallback if the blob is unreadable.

The UI lives in Settings > Accounts > Edit: OAuth accounts show a
"Sign in with Google/Microsoft again" button where the password field
would be. Before this existed the only recovery was remove-and-re-add,
which threw away cached mail, aliases, and per-account settings.

To route the user there, `oauth::access_token` recognizes the
provider's `invalid_grant` error -- the "this refresh token is dead,
retrying won't help" response -- and appends "open Settings > Accounts
and use \"Sign in again\"" to the error every mail command surfaces.

## Removing an account revokes the grant

Deleting the keychain blob alone would leave the refresh token valid at
the provider -- unusable by anyone without a copy, but also unrevokable,
sitting as a live "Helix has full mail access" entry in the user's Google
security page forever. So `account::remove_account` calls
`oauth::revoke_grant_best_effort` (RFC 7009) before deleting the
credential, and `add_oauth_account`'s rollback does the same for the
grant the just-failed onboarding minted (which would otherwise be
orphaned with no local record pointing at it at all).

Best-effort in both places, deliberately: a no-op for password accounts,
failures are logged rather than propagated (removal must work offline,
and the account being removed *because its token is dead* is the common
case -- Google answers 400 for an already-invalid token, which counts as
success). Microsoft has no revocation endpoint (`revoke_url: None` in
`ProviderConfig`), so its grants can only be revoked by the user at
account.microsoft.com; the user guide says so.

One place deliberately does **not** revoke: `reauthorize_oauth_account`'s
failure path discards the freshly minted token and restores the old blob
-- but Google's revocation endpoint kills the entire app grant, so
revoking the discarded token would take the restored one down with it.

## Why only Google and Microsoft ("what about Yahoo/AOL?")

The two shipped providers are the ones whose native-app rules our RFC
8252 flow (system browser + plain-HTTP loopback listener) can actually
satisfy. Yahoo and AOL -- the other big OAuth-only mail providers --
can't work this way: Yahoo's app registration does not accept
localhost/loopback redirect URIs at all (it requires a real https
callback domain), and its mail scope additionally requires a special
app approval. Clients like Thunderbird only manage Yahoo OAuth by
loading the consent screen in an *embedded* browser and intercepting
the `https://localhost` redirect before any TLS connection happens --
exactly the embedded-webview pattern Google blocks outright and this
codebase deliberately avoided (see the module comment in `oauth.rs`).
Supporting them would mean shipping a second, embedded-webview auth
path or a hosted redirect service; neither is worth it for providers
Helix's custom-domain target audience rarely uses. If that trade-off
is ever revisited, `ProviderConfig` is the extension point -- the rest
of the stack (XOAUTH2 on all three protocols, storage, refresh,
re-auth) is provider-agnostic.

## Verification

- Unit tests in `oauth.rs` cover the stored-blob round trip (and that a
  plain password never parses as one), the XOAUTH2 SASL string shape,
  redirect parsing (code extraction, percent-decoding, `state` mismatch
  rejection, `error=access_denied` surfacing), URL encoding of the
  reserved characters scopes actually contain, scope normalization, and
  the revoke-endpoint asymmetry (Google has one, Microsoft doesn't --
  the test doubles as the reminder should Microsoft ever grow one).
- The full browser flow needs a registered client ID and a human, so it
  has no automated test; it was exercised manually. The XOAUTH2 IMAP
  path against a real server requires a Gmail/Microsoft account and is
  covered by the same login/auth-failure convention as the other
  `#[ignore]`d server tests.
