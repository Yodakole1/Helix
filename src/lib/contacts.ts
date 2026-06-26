import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ContactRecord {
  email: string;
  display_name: string | null;
}

// Searches the local contact cache (populated by open/send events in imap.rs
// and smtp.rs). Falls back to an empty list in browser-only dev mode where
// there is no backend.
export function searchContacts(query: string, limit = 5): Promise<ContactRecord[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("search_contacts", { query, limit });
}
