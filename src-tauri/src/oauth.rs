//! OAuth2 (XOAUTH2) support for providers that are hostile to app
//! passwords -- Gmail and Microsoft 365 first. Implements the native-app
//! authorization-code flow from RFC 8252: PKCE (S256), the system browser
//! for the consent screen, and a one-shot loopback HTTP listener for the
//! redirect. No embedded webview -- Google explicitly blocks those, and
//! the system browser means the user's existing provider session (and
//! their password manager) just works.
//!
//! What lands in the OS keychain for an OAuth account is a JSON blob (see
//! [`StoredOauth`]) holding the refresh token, under the same
//! `account_id` entry a password account would use. The mail protocols
//! then branch on what the stored secret *is* rather than on a separate
//! config flag: `parse_stored` returns `Some` only for that JSON shape,
//! so `imap.rs`/`smtp.rs`/`pop3.rs` each try it once and fall back to the
//! password path. (The `accounts.auth_method` column mirrors this for the
//! frontend's benefit; the keychain blob is the source of truth.)
//!
//! Access tokens are short-lived and never persisted -- they live in an
//! in-process cache keyed by account, refreshed on demand. That matters
//! here more than in most clients because Helix opens a fresh connection
//! per command: without the cache every folder listing would cost a
//! token-endpoint round trip.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::credentials;

/// Everything provider-specific in one place. `redirect_host` differs
/// because Google's loopback rules want a literal `127.0.0.1` while
/// Microsoft's native-client registration matches `http://localhost`.
pub(crate) struct ProviderConfig {
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub scopes: &'static str,
    pub redirect_host: &'static str,
    pub imap_host: &'static str,
    pub imap_port: u16,
    pub smtp_host: &'static str,
    pub smtp_port: u16,
    pub smtp_use_starttls: bool,
    /// Extra query parameters the provider needs on the authorization URL.
    /// Google only issues a refresh token when asked (`access_type=offline`),
    /// and only reliably on a consent prompt.
    pub extra_auth_params: &'static [(&'static str, &'static str)],
    /// Compile-time default client ID, injected via environment variables
    /// at build time (`HELIX_GMAIL_CLIENT_ID` etc.) so a distributor can
    /// ship registered IDs without committing them. Users can always
    /// supply their own in the UI -- see `docs/technical/oauth.md`.
    pub default_client_id: Option<&'static str>,
    pub default_client_secret: Option<&'static str>,
}

pub(crate) fn provider_config(provider: &str) -> Result<ProviderConfig, String> {
    match provider {
        "gmail" => Ok(ProviderConfig {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scopes: "https://mail.google.com/",
            redirect_host: "127.0.0.1",
            imap_host: "imap.gmail.com",
            imap_port: 993,
            smtp_host: "smtp.gmail.com",
            smtp_port: 465,
            smtp_use_starttls: false,
            extra_auth_params: &[("access_type", "offline"), ("prompt", "consent")],
            default_client_id: option_env!("HELIX_GMAIL_CLIENT_ID"),
            default_client_secret: option_env!("HELIX_GMAIL_CLIENT_SECRET"),
        }),
        "microsoft" => Ok(ProviderConfig {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scopes: "https://outlook.office.com/IMAP.AccessAsUser.All \
                     https://outlook.office.com/SMTP.Send \
                     offline_access",
            redirect_host: "localhost",
            imap_host: "outlook.office365.com",
            imap_port: 993,
            smtp_host: "smtp.office365.com",
            smtp_port: 587,
            smtp_use_starttls: true,
            extra_auth_params: &[],
            default_client_id: option_env!("HELIX_MICROSOFT_CLIENT_ID"),
            // Microsoft public (native) clients authenticate with PKCE only.
            default_client_secret: None,
        }),
        other => Err(format!("unknown OAuth provider '{other}' (expected 'gmail' or 'microsoft')")),
    }
}

/// The keychain payload for an OAuth account. `kind` is a fixed marker so
/// `parse_stored` can distinguish this JSON from a password that merely
/// looks like JSON -- a real password would additionally have to contain
/// exactly this field with exactly this value to misparse, at which point
/// it *is* this format.
#[derive(Serialize, Deserialize)]
pub(crate) struct StoredOauth {
    kind: String,
    pub provider: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub refresh_token: String,
}

const STORED_KIND: &str = "helix-oauth2";

impl StoredOauth {
    fn new(
        provider: &str,
        client_id: String,
        client_secret: Option<String>,
        refresh_token: String,
    ) -> Self {
        StoredOauth {
            kind: STORED_KIND.to_string(),
            provider: provider.to_string(),
            client_id,
            client_secret,
            refresh_token,
        }
    }

    fn to_secret(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("could not serialize OAuth credential: {e}"))
    }
}

/// `Some` when the keychain secret for an account is an OAuth credential
/// blob rather than a plain password.
pub(crate) fn parse_stored(secret: &str) -> Option<StoredOauth> {
    let parsed: StoredOauth = serde_json::from_str(secret).ok()?;
    (parsed.kind == STORED_KIND).then_some(parsed)
}

// ---------------------------------------------------------------------------
// Access-token cache and refresh
// ---------------------------------------------------------------------------

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

fn token_cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Seeds the cache with a token we already hold (the one the authorization
/// flow just returned), so onboarding's immediate verify-login doesn't pay
/// a pointless refresh round trip.
fn cache_token(account_id: &str, access_token: String, expires_in_secs: u64) {
    let expires_at = Instant::now() + Duration::from_secs(expires_in_secs);
    token_cache()
        .lock()
        .expect("token cache lock poisoned")
        .insert(account_id.to_string(), CachedToken { access_token, expires_at });
}

/// Drops any cached token, e.g. when an account is removed or its
/// credential rotated.
pub(crate) fn forget_token(account_id: &str) {
    token_cache().lock().expect("token cache lock poisoned").remove(account_id);
}

#[derive(Deserialize)]
struct TokenEndpointResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenEndpointError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

async fn post_token_request(
    token_url: &str,
    form: &[(&str, &str)],
) -> Result<TokenEndpointResponse, String> {
    let response = reqwest::Client::new()
        .post(token_url)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("token request to {token_url} failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("could not read token response: {e}"))?;

    if !status.is_success() {
        // OAuth error bodies are structured JSON; surface the useful part
        // instead of dumping the whole payload.
        if let Ok(err) = serde_json::from_str::<TokenEndpointError>(&body) {
            let detail = err.error_description.unwrap_or_default();
            return Err(format!("token endpoint refused ({}): {detail}", err.error));
        }
        return Err(format!("token endpoint refused with HTTP {status}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("could not parse token response: {e}"))
}

/// Returns a currently-valid access token for an OAuth account, refreshing
/// via the stored refresh token when the cached one is missing or within a
/// minute of expiring. Persists a rotated refresh token back to the
/// keychain when the provider issues one (Microsoft rotates on every
/// refresh; losing the new one would eventually sign the account out).
pub(crate) async fn access_token(account_id: &str, stored: &StoredOauth) -> Result<String, String> {
    {
        let cache = token_cache().lock().expect("token cache lock poisoned");
        if let Some(entry) = cache.get(account_id) {
            if entry.expires_at > Instant::now() + Duration::from_secs(60) {
                return Ok(entry.access_token.clone());
            }
        }
    }

    let config = provider_config(&stored.provider)?;
    let mut form = vec![
        ("client_id", stored.client_id.as_str()),
        ("refresh_token", stored.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if let Some(secret) = &stored.client_secret {
        form.push(("client_secret", secret.as_str()));
    }

    let token = post_token_request(config.token_url, &form).await.map_err(|e| {
        format!("could not refresh the {} login for {account_id}: {e}", stored.provider)
    })?;

    if let Some(new_refresh) = &token.refresh_token {
        if *new_refresh != stored.refresh_token {
            let rotated = StoredOauth::new(
                &stored.provider,
                stored.client_id.clone(),
                stored.client_secret.clone(),
                new_refresh.clone(),
            );
            // Best-effort: a failed keychain write means the old (still
            // valid until used) refresh token stays stored; the next
            // successful refresh will try again.
            if let Err(e) = credentials::store_credential(account_id.to_string(), rotated.to_secret()?) {
                log::warn!("could not persist rotated refresh token for {account_id}: {e}");
            }
        }
    }

    cache_token(account_id, token.access_token.clone(), token.expires_in.unwrap_or(3600));
    Ok(token.access_token)
}

/// Convenience for the protocol modules: given the raw keychain secret
/// they already fetched, either mint an access token (OAuth account) or
/// report that this is a password account (`Ok(None)`).
pub(crate) async fn access_token_for_secret(
    account_id: &str,
    secret: &str,
) -> Result<Option<String>, String> {
    match parse_stored(secret) {
        Some(stored) => access_token(account_id, &stored).await.map(Some),
        None => Ok(None),
    }
}

/// Builds the SASL XOAUTH2 initial client response (not yet base64 --
/// each protocol layer encodes it the way its transport expects).
pub(crate) fn xoauth2_string(user: &str, access_token: &str) -> String {
    format!("user={user}\x01auth=Bearer {access_token}\x01\x01")
}

// ---------------------------------------------------------------------------
// Authorization-code flow (browser + loopback listener)
// ---------------------------------------------------------------------------

pub(crate) struct AuthorizedTokens {
    pub access_token: String,
    pub expires_in_secs: u64,
    pub refresh_token: String,
}

fn random_url_safe(len: usize) -> String {
    // The RFC 7636 unreserved set. rand's distribution over an explicit
    // alphabet keeps this dependency-free and obviously uniform.
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Extracts a query parameter's (still-encoded) value from a URL query
/// string.
fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then_some(value)
    })
}

/// Runs the full RFC 8252 authorization dance and returns the token set.
/// Blocks (asynchronously) until the user finishes in the browser or the
/// five-minute timeout lapses.
pub(crate) async fn run_authorization_flow(
    config: &ProviderConfig,
    client_id: &str,
    client_secret: Option<&str>,
    login_hint: &str,
) -> Result<AuthorizedTokens, String> {
    let listener = TcpListener::bind((config.redirect_host, 0))
        .await
        .map_err(|e| format!("could not open a local port for the OAuth redirect: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read local listener address: {e}"))?
        .port();
    let redirect_uri = format!("http://{}:{}/callback", config.redirect_host, port);

    let state = random_url_safe(32);
    let verifier = random_url_safe(64);
    let challenge = URL_SAFE_NO_PAD.encode(openssl::sha::sha256(verifier.as_bytes()));

    let mut auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&login_hint={}",
        config.auth_url,
        urlencode(client_id),
        urlencode(&redirect_uri),
        urlencode(&normalize_scopes(config.scopes)),
        urlencode(&state),
        urlencode(&challenge),
        urlencode(login_hint),
    );
    for (key, value) in config.extra_auth_params {
        auth_url.push_str(&format!("&{key}={value}"));
    }

    open::that_detached(&auth_url)
        .map_err(|e| format!("could not open the system browser for sign-in: {e}"))?;

    let code = wait_for_redirect(&listener, &state).await?;

    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }

    let token = post_token_request(config.token_url, &form).await?;
    let refresh_token = token.refresh_token.ok_or_else(|| {
        "the provider did not return a refresh token -- Helix cannot stay signed in without one \
         (for Google, the OAuth client must be of type 'Desktop app')"
            .to_string()
    })?;

    Ok(AuthorizedTokens {
        access_token: token.access_token,
        expires_in_secs: token.expires_in.unwrap_or(3600),
        refresh_token,
    })
}

/// The scopes constant is formatted with a line continuation for
/// readability; collapse the resulting internal whitespace runs back to
/// single spaces before URL-encoding.
fn normalize_scopes(scopes: &str) -> String {
    scopes.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Accepts exactly one HTTP request on the loopback listener, validates
/// the `state` parameter, and returns the (decoded) authorization code.
/// Serves a tiny "you can close this tab" page either way.
async fn wait_for_redirect(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    let accept = tokio::time::timeout(Duration::from_secs(300), listener.accept());
    let (mut stream, _) = accept
        .await
        .map_err(|_| "sign-in timed out after 5 minutes -- try again".to_string())?
        .map_err(|e| format!("could not accept the OAuth redirect connection: {e}"))?;

    // The redirect is a single small GET; 8 KiB is far more than any
    // provider's callback URL. Read once -- the request line is in the
    // first packet in practice, and a pathological trickle just fails.
    let mut buffer = vec![0u8; 8192];
    let read = stream
        .read(&mut buffer)
        .await
        .map_err(|e| format!("could not read the OAuth redirect request: {e}"))?;
    let request = String::from_utf8_lossy(&buffer[..read]);

    let result = parse_redirect_request(&request, expected_state);

    let (status, message) = match &result {
        Ok(_) => ("200 OK", "Sign-in complete. You can close this tab and return to Helix."),
        Err(e) => ("400 Bad Request", e.as_str()),
    };
    let page = format!(
        "<!doctype html><html><head><title>Helix</title></head><body style=\"font-family: sans-serif; background: #101014; color: #e8e8ee; display: flex; align-items: center; justify-content: center; height: 100vh;\"><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;

    result
}

/// Pulls the authorization code out of the redirect's request line
/// (`GET /callback?code=...&state=... HTTP/1.1`), checking `state` against
/// the value this flow generated -- a mismatch means the redirect wasn't
/// a response to our request and must not be exchanged.
fn parse_redirect_request(request: &str, expected_state: &str) -> Result<String, String> {
    let request_line = request.lines().next().unwrap_or_default();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "malformed redirect request".to_string())?;
    let query = path
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| "redirect carried no query parameters".to_string())?;

    if let Some(error) = query_param(query, "error") {
        let detail = query_param(query, "error_description")
            .map(decode_query_value)
            .unwrap_or_default();
        return Err(format!("sign-in was refused: {} {detail}", decode_query_value(error)));
    }

    let state = query_param(query, "state")
        .ok_or_else(|| "redirect carried no state parameter".to_string())?;
    if state != expected_state {
        return Err("redirect state did not match -- discarding the response".to_string());
    }

    let code = query_param(query, "code")
        .ok_or_else(|| "redirect carried no authorization code".to_string())?;
    Ok(decode_query_value(code))
}

/// Percent-decodes a query-string value (plus `+` as space).
fn decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Onboarding command
// ---------------------------------------------------------------------------

/// What the frontend needs to render the provider sign-in buttons: whether
/// a client ID is compiled in (if not, the UI must ask the user for one)
/// and which servers the account will use.
#[derive(Serialize)]
pub struct OauthProviderInfo {
    pub provider: String,
    pub has_builtin_client_id: bool,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_use_starttls: bool,
}

#[tauri::command]
pub fn oauth_provider_info(provider: String) -> Result<OauthProviderInfo, String> {
    let config = provider_config(&provider)?;
    Ok(OauthProviderInfo {
        provider,
        has_builtin_client_id: config.default_client_id.is_some(),
        imap_host: config.imap_host.to_string(),
        imap_port: config.imap_port,
        smtp_host: config.smtp_host.to_string(),
        smtp_port: config.smtp_port,
        smtp_use_starttls: config.smtp_use_starttls,
    })
}

/// Stores the OAuth credential blob for an account and seeds the access
/// token cache. Split out of `account::add_oauth_account` so the
/// credential-vs-account composition stays in `account.rs` (matching
/// `add_account`) while everything OAuth-shaped stays here.
pub(crate) fn store_authorized(
    account_id: &str,
    provider: &str,
    client_id: String,
    client_secret: Option<String>,
    tokens: AuthorizedTokens,
) -> Result<(), String> {
    let stored = StoredOauth::new(provider, client_id, client_secret, tokens.refresh_token);
    credentials::store_credential(account_id.to_string(), stored.to_secret()?)?;
    cache_token(account_id, tokens.access_token, tokens.expires_in_secs);
    Ok(())
}

/// Resolves the client ID/secret to use for a provider: an explicit
/// user-supplied one wins, then the compile-time default, otherwise a
/// clear error telling the user what to do.
pub(crate) fn resolve_client(
    config: &ProviderConfig,
    provider: &str,
    client_id_override: Option<String>,
    client_secret_override: Option<String>,
) -> Result<(String, Option<String>), String> {
    let client_id = client_id_override
        .filter(|id| !id.trim().is_empty())
        .or_else(|| config.default_client_id.map(str::to_string))
        .ok_or_else(|| {
            format!(
                "this build has no OAuth client ID for {provider} -- register one and enter it \
                 under advanced settings (see docs/technical/oauth.md)"
            )
        })?;
    let client_secret = client_secret_override
        .filter(|s| !s.trim().is_empty())
        .or_else(|| config.default_client_secret.map(str::to_string));
    Ok((client_id, client_secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_oauth_round_trips_and_rejects_plain_passwords() {
        let stored = StoredOauth::new("gmail", "id-123".into(), None, "refresh-abc".into());
        let secret = stored.to_secret().unwrap();
        let parsed = parse_stored(&secret).expect("the blob should parse back");
        assert_eq!(parsed.provider, "gmail");
        assert_eq!(parsed.client_id, "id-123");
        assert_eq!(parsed.refresh_token, "refresh-abc");

        assert!(parse_stored("hunter2").is_none());
        assert!(parse_stored("{\"kind\":\"something-else\"}").is_none());
        assert!(parse_stored("{\"looks\":\"like json\"}").is_none());
    }

    #[test]
    fn xoauth2_string_matches_the_sasl_shape() {
        let s = xoauth2_string("user@gmail.com", "ya29.token");
        assert_eq!(s, "user=user@gmail.com\x01auth=Bearer ya29.token\x01\x01");
    }

    #[test]
    fn redirect_parsing_extracts_the_code_and_checks_state() {
        let request = "GET /callback?state=abc&code=4%2F0Adeu5code HTTP/1.1\r\nHost: x\r\n\r\n";
        let code = parse_redirect_request(request, "abc").unwrap();
        assert_eq!(code, "4/0Adeu5code");

        let mismatch = parse_redirect_request(request, "different-state");
        assert!(mismatch.is_err(), "a state mismatch must be rejected");

        let denied = "GET /callback?error=access_denied&state=abc HTTP/1.1\r\n\r\n";
        let err = parse_redirect_request(denied, "abc").unwrap_err();
        assert!(err.contains("access_denied"), "got: {err}");
    }

    #[test]
    fn urlencode_covers_the_reserved_characters_scopes_use() {
        assert_eq!(urlencode("https://mail.google.com/"), "https%3A%2F%2Fmail.google.com%2F");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("safe-._~"), "safe-._~");
    }

    #[test]
    fn provider_config_rejects_unknown_providers() {
        assert!(provider_config("gmail").is_ok());
        assert!(provider_config("microsoft").is_ok());
        assert!(provider_config("aol").is_err());
    }

    #[test]
    fn scope_normalization_collapses_continuation_whitespace() {
        let config = provider_config("microsoft").unwrap();
        let scopes = normalize_scopes(config.scopes);
        assert!(!scopes.contains("  "), "got: {scopes}");
        assert!(scopes.contains("IMAP.AccessAsUser.All https://"));
    }
}
