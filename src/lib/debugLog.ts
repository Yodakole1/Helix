import { invoke } from "@tauri-apps/api/core";

// Wraps src-tauri/src/debug_log.rs -- an in-memory, bounded log of CalDAV/
// CardDAV network requests (method, URL, HTTP status or transport error),
// surfaced read-only in Settings > Data & Storage so a permissions/URL/
// network problem can be told apart at a glance instead of guessing from
// the user-facing "something went wrong" message alone.

export interface DebugLogEntry {
  timestamp: string;
  source: string;
  message: string;
}

export function getDebugLog(): Promise<DebugLogEntry[]> {
  return invoke("get_debug_log");
}

export function clearDebugLog(): Promise<void> {
  return invoke("clear_debug_log");
}
