import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around the Rust commands in src-tauri/src/pgp.rs, the same
// shape as credentials.ts. Field names stay snake_case because that's what
// `#[derive(Serialize)]` on the Rust structs produces with no rename_all
// attribute -- not a typo.
export interface PublicKeyInfo {
  public_key: string;
  fingerprint: string;
}

export interface StoredOwnKey {
  account_id: string;
  public_key: string;
  fingerprint: string;
  created_at: string;
}

export interface StoredContactKey {
  email: string;
  public_key: string;
  fingerprint: string;
  imported_at: string;
}

export function generateKeypair(accountId: string, name: string): Promise<PublicKeyInfo> {
  return invoke("generate_keypair", { accountId, name });
}

export function exportPublicKey(accountId: string): Promise<PublicKeyInfo> {
  return invoke("export_public_key", { accountId });
}

export function importOwnKey(accountId: string, armoredSecretKey: string): Promise<PublicKeyInfo> {
  return invoke("import_own_key", { accountId, armoredSecretKey });
}

export function deleteOwnKey(accountId: string): Promise<void> {
  return invoke("delete_own_key", { accountId });
}

export function importContactKey(email: string, armoredPublicKey: string): Promise<string> {
  return invoke("import_contact_key", { email, armoredPublicKey });
}

export function listOwnKeys(): Promise<StoredOwnKey[]> {
  return invoke("list_own_keys");
}

export function listContactKeys(): Promise<StoredContactKey[]> {
  return invoke("list_contact_keys");
}

export function deleteContactKey(email: string): Promise<void> {
  return invoke("delete_contact_key", { email });
}

// Fetches the recipient's public key via WKD (Web Key Directory, RFC 9637)
// -- looks up the key at the mail provider's /.well-known/openpgpkey/ path.
// Returns key material for the caller to import explicitly; does NOT
// auto-import. Throws if the key can't be found or the server doesn't
// implement WKD.
export function discoverPgpKeyWkd(email: string): Promise<PublicKeyInfo> {
  return invoke("discover_pgp_key_wkd", { email });
}

export interface WkdEnsureOutcome {
  // "already_present": a stored key was kept as-is; "imported": a new key
  // was fetched via WKD and stored.
  status: "already_present" | "imported";
  fingerprint: string;
}

// Opportunistic WKD acquisition for the compose/encrypt flow: ensures a key
// exists for `email` so the message can be encrypted, but never overwrites a
// key already on file (a manually verified key must not be silently replaced
// by whatever the domain's WKD currently serves). Use discoverPgpKeyWkd +
// importContactKey for the explicit, overwrite-capable key-management path.
// Throws if the domain publishes no key for the address.
export function ensureContactKeyWkd(email: string): Promise<WkdEnsureOutcome> {
  return invoke("ensure_contact_key_wkd", { email });
}
