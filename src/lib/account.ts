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
  smtp_host: string;
  smtp_port: number;
  smtp_use_starttls: boolean;
  archive_folder: string;
  trash_folder: string;
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
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
  archiveFolder: string | null;
  trashFolder: string | null;
}

export function addAccount(args: AddAccountArgs): Promise<AddAccountResult> {
  return invoke("add_account", args);
}

export function listAccounts(): Promise<AccountRecord[]> {
  return invoke("list_accounts");
}

export function removeAccount(accountId: string): Promise<void> {
  return invoke("remove_account", { accountId });
}
