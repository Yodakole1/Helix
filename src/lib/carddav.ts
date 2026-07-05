import { invoke } from "@tauri-apps/api/core";

export interface CardDavSource {
  id: number;
  account_id: string;
  url: string;
  display_name: string;
  username: string;
  last_synced_at: string | null;
}

// Returned by discover_carddav -- list of addressbooks found on the server.
export interface CardDavDiscoveredBook {
  url: string;
  display_name: string;
}

export interface SyncResult {
  contacts_added: number;
  contacts_updated: number;
}

// Add a CardDAV source and do an initial sync immediately. The password is
// stored in the OS keychain (never in the database). Fails if the first sync
// fails -- so the source only lands if the credentials are valid.
export function addCardDavSource(
  accountId: string,
  url: string,
  username: string,
  password: string,
  displayName: string,
): Promise<CardDavSource> {
  return invoke("add_carddav_source", { accountId, url, username, password, displayName });
}

export function listCardDavSources(): Promise<CardDavSource[]> {
  return invoke("list_carddav_sources");
}

export function deleteCardDavSource(id: number): Promise<void> {
  return invoke("delete_carddav_source", { id });
}

// Sync a single CardDAV source (fetch remote vCards, upsert contacts).
export function syncCardDav(id: number): Promise<SyncResult> {
  return invoke("sync_carddav", { id });
}

// Discover addressbook collections on a CardDAV server. Returns a list of
// books (URL + display name) the user can choose to add as sources.
export function discoverCardDav(
  host: string,
  username: string,
  password: string,
): Promise<CardDavDiscoveredBook[]> {
  return invoke("discover_carddav", { host, username, password });
}
