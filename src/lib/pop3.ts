import { invoke } from "@tauri-apps/api/core";
import type { MessageBody, AttachmentContent } from "./imap";
import { parseFromField, type SampleMessage } from "../data/messages";

export interface Pop3MessageSummary {
  number: number;
  size: number;
  uidl: string | null;
  subject: string | null;
  from: string | null;
  date: string | null;
}

export function listMessages(accountId: string, host: string, port: number): Promise<Pop3MessageSummary[]> {
  return invoke("list_messages", { accountId, host, port });
}

export function fetchPop3Message(accountId: string, host: string, port: number, number: number): Promise<MessageBody> {
  return invoke("fetch_message", { accountId, host, port, number });
}

export function pop3FetchAttachment(
  accountId: string,
  host: string,
  port: number,
  number: number,
  attachmentIndex: number,
): Promise<AttachmentContent> {
  return invoke("pop3_fetch_attachment", { accountId, host, port, number, attachmentIndex });
}

export function deleteMessage(accountId: string, host: string, port: number, number: number): Promise<void> {
  return invoke("delete_message", { accountId, host, port, number });
}

// Maps a Pop3MessageSummary to a SampleMessage. POP3 has no SEEN/FLAGGED
// flags, so all messages arrive unread and unstarred. The message number
// doubles as the id -- POP3 has no stable UIDs across sessions. UIDL is
// preserved separately so offline cache lookups (which are UIDL-keyed)
// can still resolve after the session numbers change.
export function pop3SummaryToMessage(summary: Pop3MessageSummary): SampleMessage {
  const { name: sender, email: senderEmail } = parseFromField(summary.from);
  return {
    id: summary.number,
    pop3Number: summary.number,
    pop3Uidl: summary.uidl ?? undefined,
    sender,
    senderEmail,
    to: "",
    subject: summary.subject ?? "(no subject)",
    preview: "",
    date: summary.date ?? new Date().toISOString(),
    unread: true,
    starred: false,
  };
}
