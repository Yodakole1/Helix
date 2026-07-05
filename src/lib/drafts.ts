import { invoke, isTauri } from "@tauri-apps/api/core";
import type { OutgoingAttachment } from "./smtp";

export interface DraftSummary {
  draft_id: string;
  account_id: string;
  subject: string | null;
  to_addr: string | null;
  saved_at: string;
}

export interface DraftRecord {
  draft_id: string;
  account_id: string;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  references: string[];
  // JSON-encoded OutgoingAttachment[] (or null). Decode with JSON.parse when
  // reopening a draft that carried attachments.
  attachments_json: string | null;
  imap_uid: number | null;
  saved_at: string;
}

export interface QueueResult {
  sent: boolean;
  outbox_id: string | null;
}

export interface OutboxRecord {
  outbox_id: string;
  account_id: string;
  to_addr: string;
  cc: string;
  bcc: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  in_reply_to: string | null;
  references: string[];
  encrypt: boolean;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
}

export interface FlushResult {
  sent: number;
  failed: number;
}

// Saves (or updates) a draft locally and syncs it to the IMAP Drafts folder.
// Returns the stable draft_id that should be passed back on subsequent saves
// so the same row is updated rather than a new one created.
export function saveDraft(args: {
  accountId: string;
  imapHost: string;
  imapPort: number;
  draftsFolder: string;
  draftId: string | null;
  to: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml?: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments?: OutgoingAttachment[];
}): Promise<string> {
  if (!isTauri()) return Promise.resolve(args.draftId ?? crypto.randomUUID());
  return invoke("save_draft", {
    accountId: args.accountId,
    imapHost: args.imapHost,
    imapPort: args.imapPort,
    draftsFolder: args.draftsFolder,
    draftId: args.draftId ?? null,
    to: args.to,
    subject: args.subject,
    bodyText: args.bodyText,
    bodyHtml: args.bodyHtml ?? null,
    inReplyTo: args.inReplyTo ?? null,
    references: args.references,
    attachments: args.attachments ?? [],
  });
}

export function listDrafts(accountId: string): Promise<DraftSummary[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_drafts", { accountId });
}

export function getDraft(draftId: string): Promise<DraftRecord | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke("get_draft", { draftId });
}

export function deleteDraft(args: {
  accountId: string;
  imapHost: string;
  imapPort: number;
  draftsFolder: string;
  draftId: string;
}): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("delete_draft", {
    accountId: args.accountId,
    imapHost: args.imapHost,
    imapPort: args.imapPort,
    draftsFolder: args.draftsFolder,
    draftId: args.draftId,
  });
}

// Queues a message for sending. Tries to deliver immediately; if that fails
// (offline, transient SMTP error), the message stays in the outbox. Call
// flushOutbox on reconnect to retry queued messages. Pass `sendAt` (RFC 3339)
// to defer delivery (Send Later, or undo-send hold); pass `fromOverride` to
// send from an alias instead of the account's primary address.
export function queueForSend(args: {
  accountId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
  to: string;
  // Comma-separated address lists, same shape as `to`; "" means none.
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: OutgoingAttachment[];
  inReplyTo: string | null;
  references: string[];
  encrypt: boolean;
  sendAt?: string | null;
  fromOverride?: string | null;
}): Promise<QueueResult> {
  if (!isTauri()) return Promise.resolve({ sent: false, outbox_id: null });
  return invoke("queue_for_send", {
    accountId: args.accountId,
    smtpHost: args.smtpHost,
    smtpPort: args.smtpPort,
    smtpUseStarttls: args.smtpUseStarttls,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    bodyText: args.bodyText,
    bodyHtml: args.bodyHtml,
    attachments: args.attachments,
    inReplyTo: args.inReplyTo,
    references: args.references,
    encrypt: args.encrypt,
    sendAt: args.sendAt ?? null,
    fromOverride: args.fromOverride ?? null,
  });
}

// Cancels a message that is still in the outbox (not yet sent). Silently
// succeeds if the outbox_id is no longer present (already sent or flushed).
export function cancelQueuedSend(outboxId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("cancel_queued_send", { outboxId });
}

export function listOutbox(accountId: string): Promise<OutboxRecord[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_outbox", { accountId });
}

export function flushOutbox(accountId: string): Promise<FlushResult> {
  if (!isTauri()) return Promise.resolve({ sent: 0, failed: 0 });
  return invoke("flush_outbox", { accountId });
}
