import { invoke } from "@tauri-apps/api/core";
import type { MessageSummary, MessageBody, AttachmentContent } from "./imap";
import type { Pop3MessageSummary } from "./pop3";

// Wraps src-tauri/src/cache.rs's cache_stats/clear_cache plus the
// offline-read commands.

export interface CacheStats {
  message_count: number;
  size_bytes: number;
}

export function cacheStats(): Promise<CacheStats> {
  return invoke("cache_stats");
}

export function clearCache(): Promise<void> {
  return invoke("clear_cache");
}

// Offline read: the last-cached summaries for a folder, newest first, with
// no network access. The frontend falls back to this when a live
// fetch_messages fails so the mailbox isn't blank.
export function loadCachedMessages(accountId: string, folder: string, limit: number): Promise<MessageSummary[]> {
  return invoke("load_cached_messages", { accountId, folder, limit });
}

// Offline read of one message body. null means the body isn't cached and a
// live fetch is required.
export function loadCachedMessageBody(accountId: string, folder: string, uid: number): Promise<MessageBody | null> {
  return invoke("load_cached_message_body", { accountId, folder, uid });
}

// Offline attachment download. null means the attachment was never cached
// and a live fetch is required. Called as a fallback by handleDownloadAttachment
// in App.tsx when the live fetch_attachment fails (e.g. offline).
export function loadCachedAttachment(
  accountId: string,
  folder: string,
  uid: number,
  attachmentIndex: number,
): Promise<AttachmentContent | null> {
  return invoke("load_cached_attachment", { accountId, folder, uid, attachmentIndex });
}

// Offline read for a POP3 account's cached message list, newest-first.
// Same shape as a live list_messages response, so pop3SummaryToMessage
// works on both paths. The `number` values are from the session that last
// fetched -- they are stale across POP3 reconnects, so only `uidl` should
// be used as a key for cache lookups.
export function loadCachedPop3Messages(accountId: string, limit: number): Promise<Pop3MessageSummary[]> {
  return invoke("load_cached_pop3_messages", { accountId, limit });
}

// Offline body read for one POP3 message, keyed by UIDL. null if not cached.
export function loadCachedPop3MessageBody(accountId: string, uidl: string): Promise<MessageBody | null> {
  return invoke("load_cached_pop3_message_body", { accountId, uidl });
}

// Offline attachment download for a POP3 message, keyed by UIDL. null if not cached.
export function loadCachedPop3Attachment(
  accountId: string,
  uidl: string,
  attachmentIndex: number,
): Promise<AttachmentContent | null> {
  return invoke("load_cached_pop3_attachment", { accountId, uidl, attachmentIndex });
}

// One hit from the offline full-text search over the encrypted cache. Same
// shape as a MessageSummary, plus which account+folder it lives in (the
// search spans every cached account/folder at once).
export interface LocalSearchResult {
  account_id: string;
  folder: string;
  uid: number;
  subject: string | null;
  from: string | null;
  date: string | null;
  seen: boolean;
  flagged: boolean;
}

// Offline / global full-text search (SQLite FTS5 over the encrypted cache).
// No network. `accountId` null searches every cached account; passing an id
// scopes it to that one. Matches Subject/From/Body of already-cached mail,
// so it surfaces matches older than the live fetch window and in folders
// that aren't currently open.
export function searchLocalMessages(
  accountId: string | null,
  query: string,
  limit: number,
  filters?: {
    fromFilter?: string | null;
    subjectFilter?: string | null;
    hasAttachment?: boolean | null;
    isUnread?: boolean | null;
    isFlagged?: boolean | null;
  },
): Promise<LocalSearchResult[]> {
  return invoke("search_local_messages", {
    accountId,
    query,
    limit,
    fromFilter: filters?.fromFilter ?? null,
    subjectFilter: filters?.subjectFilter ?? null,
    hasAttachment: filters?.hasAttachment ?? null,
    isUnread: filters?.isUnread ?? null,
    isFlagged: filters?.isFlagged ?? null,
  });
}

// Total unseen count across all cached folders. Pass null for all accounts;
// pass an account id to scope to that account only. Accurate for anything that
// has been fetched and written through to the cache; the frontend calls this
// after folder loads and mark-seen mutations to keep tab badges current.
export function getUnseenCount(accountId: string | null): Promise<number> {
  return invoke("get_unseen_count", { accountId });
}
