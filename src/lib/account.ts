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
  drafts_folder: string;
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
}

export function addAccount(args: AddAccountArgs): Promise<AddAccountResult> {
  return invoke("add_account", args);
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

export function listAccounts(): Promise<AccountRecord[]> {
  return invoke("list_accounts");
}

export function removeAccount(accountId: string): Promise<void> {
  return invoke("remove_account", { accountId });
}
