import { invoke, isTauri } from "@tauri-apps/api/core";

export interface SnoozedMessage {
  id: string;
  account_id: string;
  folder: string | null;
  uid: number | null;
  pop3_uidl: string | null;
  subject: string | null;
  sender: string | null;
  snooze_until: string;
  created_at: string;
}

export interface SnoozeArgs {
  accountId: string;
  folder?: string | null;
  uid?: number | null;
  pop3Uidl?: string | null;
  subject?: string | null;
  sender?: string | null;
  snoozeUntil: string; // RFC 3339 / ISO 8601
}

export function snoozeMessage(args: SnoozeArgs): Promise<string> {
  if (!isTauri()) return Promise.resolve("mock-snooze-id");
  return invoke("snooze_message", {
    accountId: args.accountId,
    folder: args.folder ?? null,
    uid: args.uid ?? null,
    pop3Uidl: args.pop3Uidl ?? null,
    subject: args.subject ?? null,
    sender: args.sender ?? null,
    snoozeUntil: args.snoozeUntil,
  });
}

export function cancelSnooze(id: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("cancel_snooze", { id });
}

export function listDueSnoozed(): Promise<SnoozedMessage[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_due_snoozed");
}

export function listAllSnoozed(accountId: string): Promise<SnoozedMessage[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke("list_all_snoozed", { accountId });
}
