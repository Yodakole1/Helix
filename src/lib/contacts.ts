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

// Lists the whole address book, most-recently-seen first, for a contact-
// management view (as opposed to searchContacts' compose-time autocomplete).
export function listContacts(limit = 500): Promise<ContactRecord[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_contacts", { limit });
}

// Removes one harvested contact by email. The address book accumulates
// automatically, so this is how a user forgets a one-off or mistyped address.
export function deleteContact(email: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("delete_contact", { email });
}
