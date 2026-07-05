import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";

// Thin wrappers around src-tauri/src/identities.rs.
// Mutes are account-scoped and keyed by the root message's Message-ID (angle
// brackets stripped, the same format stored in the cache).

export function muteThread(accountId: string, messageId: string): Promise<void> {
  return invoke("mute_thread", { accountId, messageId });
}

export function unmuteThread(accountId: string, messageId: string): Promise<void> {
  return invoke("unmute_thread", { accountId, messageId });
}

export function listMutedThreads(accountId: string): Promise<string[]> {
  return invoke("list_muted_threads", { accountId });
}

// Send-as identities (aliases) for an account. The `address` is the From
// address shown in outgoing mail; authentication still uses the account's
// stored credential.

export interface IdentitySummary {
  account_id: string;
  address: string;
  display_name: string | null;
  signature: string | null;
}

export function listIdentities(accountId: string): Promise<IdentitySummary[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_identities", { accountId });
}

export function addIdentity(
  accountId: string,
  address: string,
  displayName: string | null,
  signature: string | null,
): Promise<void> {
  return invoke("add_identity", { accountId, address, displayName, signature });
}

export function deleteIdentity(accountId: string, address: string): Promise<void> {
  return invoke("delete_identity", { accountId, address });
}
