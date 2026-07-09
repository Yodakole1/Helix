import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around the Rust commands in src-tauri/src/credentials.rs.
// Secrets never touch app storage directly — they go straight to the OS
// keychain (Secret Service on Linux, Keychain on macOS, Credential Manager
// on Windows) via the `keyring` crate on the Rust side.

export function storeCredential(accountId: string, secret: string): Promise<void> {
  return invoke("store_credential_cmd", { accountId, secret });
}

export function deleteCredential(accountId: string): Promise<void> {
  return invoke("delete_credential_cmd", { accountId });
}
