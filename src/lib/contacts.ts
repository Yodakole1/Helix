import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ContactRecord {
  email: string;
  display_name: string | null;
  // "local" for harvested/manually-added contacts, "carddav:<id>" for
  // contacts synced from a CardDAV address book.
  source: string;
}

// Searches the local contact cache (populated by open/send events in imap.rs
// and smtp.rs). Falls back to an empty list in browser-only dev mode where
// there is no backend. `source` narrows to one origin (see ContactRecord).
export function searchContacts(query: string, limit = 5, source?: string): Promise<ContactRecord[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("search_contacts", { query, limit, source: source ?? null });
}

// Lists the whole address book, most-recently-seen first, for a contact-
// management view (as opposed to searchContacts' compose-time autocomplete).
export function listContacts(limit = 500, source?: string): Promise<ContactRecord[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_contacts", { limit, source: source ?? null });
}

// Removes one harvested contact by email. The address book accumulates
// automatically, so this is how a user forgets a one-off or mistyped address.
export function deleteContact(email: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("delete_contact", { email });
}

// Sets (or clears) a contact's display name.
export function updateContact(email: string, displayName: string | null): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("update_contact", { email, displayName });
}

// Adds a contact by hand (source "local").
export function addContact(email: string, displayName: string | null): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("add_contact", { email, displayName });
}
