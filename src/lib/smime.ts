import { invoke } from "@tauri-apps/api/core";

// Thin wrappers around src-tauri/src/smime.rs. Field names stay snake_case
// to match serde's default serialization -- no rename_all in the Rust structs.

export interface SmimeOwnCertInfo {
  account_id: string;
  fingerprint: string;
  subject_cn: string | null;
  not_after: string;
}

export interface SmimeContactCertInfo {
  email: string;
  fingerprint: string;
  subject_cn: string | null;
  not_after: string;
  added_at: string;
}

// Returned by get_smime_cert_info for previewing a cert before import.
export interface SmimeCertPreview {
  fingerprint: string;
  subject_cn: string | null;
  issuer_cn: string | null;
  not_before: string;
  not_after: string;
  email_san: string[];
}

// Import a PKCS#12 bundle (.p12 / .pfx) for an account's own cert/key pair.
// pkcs12_base64 is the file bytes encoded as standard base64.
// The password is used once to unlock the bundle and never stored.
export function importSmimeCert(
  accountId: string,
  pkcs12Base64: string,
  password: string,
): Promise<void> {
  return invoke("import_smime_cert", { accountId, pkcs12Base64, password });
}

// Returns the own certificate as a PEM string (public cert only, no key).
export function exportSmimeCert(accountId: string): Promise<string> {
  return invoke("export_smime_cert", { accountId });
}

export function listOwnSmimeCerts(): Promise<SmimeOwnCertInfo[]> {
  return invoke("list_own_smime_certs");
}

export function deleteSmimeCert(accountId: string): Promise<void> {
  return invoke("delete_smime_cert", { accountId });
}

// Import a contact's certificate (PEM or DER base64). Used for manual import;
// certs are also harvested automatically when verified signed mail is opened.
export function importContactSmimeCert(
  email: string,
  certPemOrDerBase64: string,
): Promise<void> {
  return invoke("import_contact_smime_cert", { email, certPemOrDerBase64 });
}

export function listContactSmimeCerts(): Promise<SmimeContactCertInfo[]> {
  return invoke("list_contact_smime_certs");
}

export function deleteContactSmimeCert(email: string): Promise<void> {
  return invoke("delete_contact_smime_cert", { email });
}

// Parse and preview a cert (not yet stored) -- used in the import flow to show
// what's inside a file before the user confirms.
export function getSmimeCertInfo(certPemOrDerBase64: string): Promise<SmimeCertPreview> {
  return invoke("get_smime_cert_info", { certPemOrDerBase64 });
}
