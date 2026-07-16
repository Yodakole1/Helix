import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around the Rust commands in src-tauri/src/account.rs, same
// shape as credentials.ts/pgp.ts. Field names on the returned records
// stay snake_case -- that's what `#[derive(Serialize)]` produces with no
// rename_all attribute on the Rust side, not a typo.

export interface AccountRecord {
  account_id: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  imap_use_starttls: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_use_starttls: boolean;
  // "imap" or "pop3". For a pop3 account the imap_* fields are empty
  // placeholders and pop3_host/pop3_port carry the real incoming server.
  incoming_protocol: string;
  pop3_host: string | null;
  pop3_port: number | null;
  archive_folder: string;
  trash_folder: string;
  spam_folder: string;
  drafts_folder: string;
  sent_folder: string;
  // "password" or "oauth2". An oauth2 account has no password to rotate --
  // its keychain entry holds a refresh token managed by the backend.
  auth_method: string;
  // "gmail" | "microsoft" when auth_method is "oauth2", otherwise null.
  oauth_provider: string | null;
}

export interface AddAccountResult {
  account_id: string;
  folders: string[];
}

export interface AddAccountArgs {
  [key: string]: unknown;
  accountId: string;
  password: string;
  // Explicit null (not omitted) for "not provided" -- Tauri's generated
  // arg deserializer expects every parameter present in the JSON object;
  // an Option<T> on the Rust side maps to a present-but-null value, not a
  // missing key.
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapUseStarttls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
  archiveFolder: string | null;
  trashFolder: string | null;
  draftsFolder: string | null;
  spamFolder: string | null;
  sentFolder: string | null;
}

export function addAccount(args: AddAccountArgs): Promise<AddAccountResult> {
  return invoke("add_account", args);
}

export interface AddOauthAccountArgs {
  [key: string]: unknown;
  accountId: string;
  provider: "gmail" | "microsoft";
  displayName: string | null;
  // Only needed when the build ships without a registered OAuth client ID
  // for the provider (oauthProviderInfo().has_builtin_client_id is false).
  clientId: string | null;
  clientSecret: string | null;
}

// Runs the whole browser sign-in flow on the Rust side -- this resolves
// only after the user finishes (or abandons) the consent screen, so treat
// it like a long-running call, not a quick lookup. No secret ever crosses
// into JS: the refresh token goes keychain-direct in Rust.
export function addOauthAccount(args: AddOauthAccountArgs): Promise<AddAccountResult> {
  return invoke("add_oauth_account", args);
}

export interface OauthProviderInfo {
  provider: string;
  has_builtin_client_id: boolean;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  smtp_use_starttls: boolean;
}

export function oauthProviderInfo(provider: "gmail" | "microsoft"): Promise<OauthProviderInfo> {
  return invoke("oauth_provider_info", { provider });
}

export interface AddPop3AccountArgs {
  [key: string]: unknown;
  accountId: string;
  password: string;
  displayName: string | null;
  pop3Host: string;
  pop3Port: number;
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
}

export function addPop3Account(args: AddPop3AccountArgs): Promise<AddAccountResult> {
  return invoke("add_pop3_account", args);
}

export interface UpdateAccountArgs {
  [key: string]: unknown;
  accountId: string;
  // null leaves the stored password untouched (a host/port-only change);
  // a string rotates the keychain credential.
  password: string | null;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapUseStarttls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
}

export function updateAccount(args: UpdateAccountArgs): Promise<void> {
  return invoke("update_account", args);
}

// One row of the backend unified inbox -- a MessageSummary (the fields are
// flattened in over the wire) tagged with which account it came from.
export interface UnifiedMessageSummary {
  account_id: string;
  uid: number | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  message_id: string | null;
  in_reply_to: string | null;
}

// Fans fetch_messages out across every stored IMAP account's INBOX in one
// call (POP3 accounts are skipped server-side) and returns them merged by
// date. Lets the unified view populate accounts the user never opened
// individually, instead of relying on each account's INBOX being loaded.
export function fetchUnifiedInbox(limit: number): Promise<UnifiedMessageSummary[]> {
  return invoke("fetch_unified_inbox", { limit });
}

// Moves to the account's configured spam folder AND tags $Junk so a
// server-side Bayesian filter learns from the move.
export function reportSpam(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
): Promise<void> {
  return invoke("report_spam", { accountId, host, port, folder, uid });
}

// Re-runs the browser sign-in for an existing OAuth account -- the fix
// for a dead refresh token (revoked, expired, password changed) that
// doesn't lose the account's cached mail, aliases, or settings. Resolves
// only after the user finishes in the browser, like addOauthAccount; on
// failure the previous credential is restored, so nothing gets worse.
export function reauthorizeOauthAccount(accountId: string): Promise<void> {
  return invoke("reauthorize_oauth_account", { accountId });
}

export interface AccountImportOutcome {
  email: string;
  // "added", "skipped" (already configured), or "failed".
  status: string;
  // The error for failed/skipped rows; for added rows, notes about the
  // optional CalDAV/CardDAV side (e.g. nothing discovered).
  detail: string | null;
  calendars_added: number;
  address_books_added: number;
}

export interface ImportAccountsReport {
  results: AccountImportOutcome[];
  // The import file holds plaintext passwords, so the backend deletes it
  // after the run. false means the user has to delete it by hand.
  file_deleted: boolean;
  delete_error: string | null;
}

// Bulk onboarding from a "key: value" text file (one block per account --
// accounts-import.example.txt in the repo is the reference). Each account
// is verified against the real server exactly like addAccount; the file
// is deleted afterwards. A parse error rejects the whole call and leaves
// the file in place; per-account failures land in the report instead.
export function importAccountsFile(path: string): Promise<ImportAccountsReport> {
  return invoke("import_accounts_file", { path });
}

// One mail account discovered in a Thunderbird profile (settings only --
// Thunderbird encrypts passwords, so the user still types theirs once).
export interface ThunderbirdAccount {
  email: string;
  display_name: string | null;
  protocol: "imap" | "pop3";
  incoming_host: string;
  incoming_port: number;
  incoming_starttls: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_starttls: boolean;
}

// Reads the local Thunderbird profile(s) and returns the mail accounts found
// so onboarding can pre-fill from them. Read-only; empty array = nothing
// found (Thunderbird not installed or no IMAP/POP3 accounts), not an error.
export function discoverThunderbirdAccounts(): Promise<ThunderbirdAccount[]> {
  return invoke("discover_thunderbird_accounts");
}

// Imports one account picked from the Thunderbird checklist, password
// included (Thunderbird's own store is encrypted, so the user types theirs
// once per account). Goes through the exact same verify/save/CalDAV/CardDAV
// path as addAccount. Never rejects -- failures come back as a "failed" row,
// same shape as ImportAccountsReport's per-row results -- so the caller can
// run a whole selected batch sequentially and update one row per call
// without a try/catch around each one.
export function importThunderbirdAccount(spec: ThunderbirdAccount & { password: string }): Promise<AccountImportOutcome> {
  return invoke("import_thunderbird_account", { spec });
}

export function listAccounts(): Promise<AccountRecord[]> {
  return invoke("list_accounts");
}

export function removeAccount(accountId: string): Promise<void> {
  return invoke("remove_account", { accountId });
}
