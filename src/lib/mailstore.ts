import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around src-tauri/src/mailstore.rs -- mail import (mbox /
// EML) and bulk export. All of these are IMAP-only and can run for a
// while on big archives; callers should show a busy state.

export interface ImportResult {
  imported: number;
  failed: number;
  first_error: string | null;
}

export function importMbox(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  path: string,
): Promise<ImportResult> {
  return invoke("import_mbox", { accountId, host, port, folder, path });
}

export function importEmlFiles(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  paths: string[],
): Promise<ImportResult> {
  return invoke("import_eml_files", { accountId, host, port, folder, paths });
}

// Returns how many messages were written.
export function exportFolderMbox(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  destPath: string,
): Promise<number> {
  return invoke("export_folder_mbox", { accountId, host, port, folder, destPath });
}

export interface FolderExport {
  folder: string;
  messages: number;
  file: string;
}

export function exportAccountMbox(
  accountId: string,
  host: string,
  port: number,
  destDir: string,
): Promise<FolderExport[]> {
  return invoke("export_account_mbox", { accountId, host, port, destDir });
}
