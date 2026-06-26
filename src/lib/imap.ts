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
  from: string | null;
  to: string[];
  cc: string[];
  reply_to: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
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
