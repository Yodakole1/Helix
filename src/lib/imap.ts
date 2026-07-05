import { invoke } from "@tauri-apps/api/core";

// Thin TS wrappers around the Rust commands in src-tauri/src/imap.rs.
// Field names stay snake_case -- that's what serde's default Serialize
// produces on the Rust side.

export interface MessageSummary {
  uid: number | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  message_id: string | null;
  in_reply_to: string | null;
}

// A conversation thread: a root message and its nested reply chain.
export interface ThreadedMessage {
  message: MessageSummary;
  replies: ThreadedMessage[];
}

export interface AttachmentInfo {
  index: number;
  filename: string | null;
  content_type: string | null;
  size: number;
}

export interface MessageBody {
  text: string | null;
  html: string | null;
  attachments: AttachmentInfo[];
  pgp_signed_by: string | null;
  pgp_signature_valid: boolean | null;
  // S/MIME fields -- populated by smime.rs when the message was signed or
  // encrypted; null/false when S/MIME wasn't involved.
  smime_signed: boolean;
  smime_verified: boolean | null;
  smime_encrypted: boolean;
  smime_signer_email: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  reply_to: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  disposition_notification_to: string | null;
}

export function listFolders(accountId: string, host: string, port: number): Promise<string[]> {
  return invoke("list_folders", { accountId, host, port });
}

export function fetchMessages(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  limit: number,
): Promise<MessageSummary[]> {
  return invoke("fetch_messages", { accountId, host, port, folder, limit });
}

export function fetchThreadedMessages(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  limit: number,
): Promise<ThreadedMessage[]> {
  return invoke("fetch_threaded_messages", { accountId, host, port, folder, limit });
}

// Server-side IMAP search: matches `query` as a substring of Subject/From/
// To/Body across the whole folder, returns the newest `limit` matches.
export function searchMessages(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  query: string,
  limit: number,
): Promise<MessageSummary[]> {
  return invoke("search_messages", { accountId, host, port, folder, query, limit });
}

export function fetchMessageBody(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
): Promise<MessageBody> {
  return invoke("fetch_message_body", { accountId, host, port, folder, uid });
}

export function setMessageSeen(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
  seen: boolean,
): Promise<void> {
  return invoke("set_message_seen", { accountId, host, port, folder, uid, seen });
}

export function setMessageFlagged(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
  flagged: boolean,
): Promise<void> {
  return invoke("set_message_flagged", { accountId, host, port, folder, uid, flagged });
}

export function moveMessageToFolder(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
  destinationFolder: string,
): Promise<void> {
  return invoke("move_message_to_folder", { accountId, host, port, folder, uid, destinationFolder });
}

// --- Batch / multi-select mutations (one round-trip for the whole selection) ---

export function setMessagesSeen(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uids: number[],
  seen: boolean,
): Promise<void> {
  return invoke("set_messages_seen", { accountId, host, port, folder, uids, seen });
}

export function setMessagesFlagged(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uids: number[],
  flagged: boolean,
): Promise<void> {
  return invoke("set_messages_flagged", { accountId, host, port, folder, uids, flagged });
}

export function moveMessagesToFolder(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uids: number[],
  destinationFolder: string,
): Promise<void> {
  return invoke("move_messages_to_folder", { accountId, host, port, folder, uids, destinationFolder });
}

// "Mark all as read/unread" for a whole folder in one shot.
export function markFolderSeen(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  seen: boolean,
): Promise<void> {
  return invoke("mark_folder_seen", { accountId, host, port, folder, seen });
}

// --- Folder operations ---

export function createFolder(accountId: string, host: string, port: number, folder: string): Promise<void> {
  return invoke("create_folder", { accountId, host, port, folder });
}

export function deleteFolder(accountId: string, host: string, port: number, folder: string): Promise<void> {
  return invoke("delete_folder", { accountId, host, port, folder });
}

export function renameFolder(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  newName: string,
): Promise<void> {
  return invoke("rename_folder", { accountId, host, port, folder, newName });
}

// Permanently removes every message in a folder (the "empty trash" action).
export function emptyFolder(accountId: string, host: string, port: number, folder: string): Promise<void> {
  return invoke("empty_folder", { accountId, host, port, folder });
}

export interface AttachmentContent {
  filename: string | null;
  content_type: string | null;
  // Standard base64.
  content_base64: string;
}

export function fetchAttachment(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
  attachmentIndex: number,
): Promise<AttachmentContent> {
  return invoke("fetch_attachment", { accountId, host, port, folder, uid, attachmentIndex });
}

// --- Folder subscription management (SUBSCRIBE / UNSUBSCRIBE / LSUB) ---

export function subscribeFolder(accountId: string, host: string, port: number, folder: string): Promise<void> {
  return invoke("subscribe_folder", { accountId, host, port, folder });
}

export function unsubscribeFolder(accountId: string, host: string, port: number, folder: string): Promise<void> {
  return invoke("unsubscribe_folder", { accountId, host, port, folder });
}

// Returns only the folders the server considers subscribed (LSUB), as
// opposed to listFolders which returns all folders (LIST).
export function listSubscribedFolders(accountId: string, host: string, port: number): Promise<string[]> {
  return invoke("list_subscribed_folders", { accountId, host, port });
}

// Returns the raw RFC 822 message bytes encoded as standard base64.
// Identical to what fetch_raw_message_by_uid returns internally; the base64
// wrapper keeps the IPC boundary clean. These bytes ARE a valid .eml file
// with no extra framing, so EML export is just a download of the same bytes.
export function fetchMessageSource(
  accountId: string,
  host: string,
  port: number,
  folder: string,
  uid: number,
): Promise<string> {
  return invoke("fetch_message_source", { accountId, host, port, folder, uid });
}
