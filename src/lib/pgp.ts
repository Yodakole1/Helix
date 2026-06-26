import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around the Rust commands in src-tauri/src/pgp.rs, the same
// shape as credentials.ts. PublicKeyInfo's fields stay snake_case because
// that's what `#[derive(Serialize)]` on the Rust struct produces with no
// rename_all attribute -- not a typo.
export interface PublicKeyInfo {
  public_key: string;
  fingerprint: string;
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

export function importContactKey(email: string, armoredPublicKey: string): Promise<string> {
  return invoke("import_contact_key", { email, armoredPublicKey });
}
