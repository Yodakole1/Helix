import { useState } from "react";
import { FOLDERS } from "../data/folders";
import { type SampleMessage, type RealAttachment } from "../data/messages";
import { applyRules as resolveRuleActions, type Rule } from "../lib/rules";
import type { AccountId } from "../theme";
import type { MailAccount } from "../data/accounts";
import type { MessageBody } from "../lib/imap";

export interface MessageWithFolder extends SampleMessage {
  folder: string;
  accountId: AccountId;
}

function keyFor(account: AccountId, folder: string): string {
  return `${account}:${folder}`;
}

export function useMessageStore() {
  const [messagesByKey, setMessagesByKey] = useState<Record<string, SampleMessage[]>>({});

  function getMessages(account: AccountId, folder: string): SampleMessage[] {
    return messagesByKey[keyFor(account, folder)] ?? [];
  }

  // Replaces the message list for one account+folder with freshly fetched
  // data from the backend. Called by App.tsx after fetch_messages returns.
  function loadMessages(account: AccountId, folder: string, messages: SampleMessage[]) {
    setMessagesByKey((current) => ({ ...current, [keyFor(account, folder)]: messages }));
  }

  // Merges a fetched MessageBody into the matching stored message. Called
  // by App.tsx after fetch_message_body returns when a message is opened.
  function updateMessageBody(account: AccountId, folder: string, id: number, body: MessageBody) {
    const realAttachments: RealAttachment[] = body.attachments.map((att) => ({
      index: att.index,
      name: att.filename ?? `attachment-${att.index}`,
      contentType: att.content_type,
      size: att.size,
    }));

    updateMessage(account, folder, id, {
      textBody: body.text ?? undefined,
      htmlBody: body.html ?? undefined,
      realAttachments,
      messageId: body.message_id ?? undefined,
      inReplyTo: body.in_reply_to ?? undefined,
      references: body.references.length > 0 ? body.references : undefined,
      replyTo: body.reply_to ?? undefined,
      pgpSignedBy: body.pgp_signed_by ?? undefined,
      pgpSignatureValid: body.pgp_signature_valid ?? undefined,
      // Overwrite sender/to with the richer body-parsed versions, which
      // include proper display-name extraction by mail_parser rather than
      // the envelope-only format_address from fetch_messages.
      sender: body.from ? extractName(body.from) : undefined,
      senderEmail: body.from ? extractEmail(body.from) : undefined,
      to: body.to[0] ?? undefined,
      cc: body.cc[0] ?? undefined,
      bodyLoaded: true,
    } as Partial<SampleMessage>);
  }

  // Every folder's messages for the account, each tagged with which folder
  // it came from -- used for searching across the whole account rather
  // than just whatever folder happens to be open.
  function getAllMessages(account: AccountId, folders: string[]): MessageWithFolder[] {
    return folders.flatMap((folder) =>
      getMessages(account, folder).map((message) => ({ ...message, folder, accountId: account })),
    );
  }

  // Every account's Inbox, merged -- the data behind Settings' "Unified
  // inbox" toggle. Inbox only (not every folder of every account): that's
  // what "unified inbox" means in most mail clients.
  function getUnifiedInbox(accounts: MailAccount[]): MessageWithFolder[] {
    return accounts.flatMap((account) => {
      const messages = getMessages(account.id, "INBOX");
      return messages.map((message) => ({ ...message, folder: "INBOX", accountId: account.id }));
    });
  }

  // Every folder of every account -- what the search box reaches when
  // Unified inbox is on.
  function getEverything(accounts: MailAccount[], foldersByAccount: Record<AccountId, string[]>): MessageWithFolder[] {
    return accounts.flatMap((account) => {
      const folders = foldersByAccount[account.id] ?? FOLDERS.map((f) => f.id);
      return getAllMessages(account.id, folders);
    });
  }

  function findMessage(account: AccountId, folder: string, id: number): SampleMessage | undefined {
    return getMessages(account, folder).find((message) => message.id === id);
  }

  function findMessageIndex(account: AccountId, folder: string, id: number): number {
    return getMessages(account, folder).findIndex((message) => message.id === id);
  }

  function updateMessage(account: AccountId, folder: string, id: number, patch: Partial<SampleMessage>) {
    setMessagesByKey((current) => {
      const key = keyFor(account, folder);
      const list = current[key];
      if (!list) return current;
      const index = list.findIndex((message) => message.id === id);
      if (index === -1) return current;
      const existing = list[index];
      const changed = (Object.keys(patch) as (keyof SampleMessage)[]).some((field) => existing[field] !== patch[field]);
      if (!changed) return current;
      const nextList = [...list];
      nextList[index] = { ...existing, ...patch };
      return { ...current, [key]: nextList };
    });
  }

  function markRead(account: AccountId, folder: string, id: number) {
    updateMessage(account, folder, id, { unread: false });
  }

  function markUnread(account: AccountId, folder: string, id: number) {
    updateMessage(account, folder, id, { unread: true });
  }

  function setStarred(account: AccountId, folder: string, id: number, starred: boolean) {
    updateMessage(account, folder, id, { starred });
  }

  function toggleStar(account: AccountId, folder: string, id: number) {
    const message = findMessage(account, folder, id);
    if (!message) return;
    setStarred(account, folder, id, !message.starred);
  }

  function moveMessage(account: AccountId, fromFolder: string, id: number, toFolder: string) {
    if (fromFolder === toFolder) return;
    setMessagesByKey((current) => {
      const fromKey = keyFor(account, fromFolder);
      const toKey = keyFor(account, toFolder);
      const fromList = current[fromKey];
      if (!fromList) return current;
      const message = fromList.find((candidate) => candidate.id === id);
      if (!message) return current;
      const toList = current[toKey] ?? [];
      return {
        ...current,
        [fromKey]: fromList.filter((candidate) => candidate.id !== id),
        [toKey]: [message, ...toList],
      };
    });
  }

  function applyRules(rules: Rule[], account: AccountId, folder: string): number {
    const messages = getMessages(account, folder);
    let affected = 0;
    for (const message of messages) {
      const actions = resolveRuleActions(rules, message);
      if (actions.length === 0) continue;
      affected += 1;
      const moveAction = actions.find((action) => action.type === "moveTo");
      if (actions.some((action) => action.type === "markRead")) markRead(account, folder, message.id);
      if (actions.some((action) => action.type === "star")) setStarred(account, folder, message.id, true);
      if (moveAction && moveAction.type === "moveTo") moveMessage(account, folder, message.id, moveAction.folder);
    }
    return affected;
  }

  return {
    getMessages,
    loadMessages,
    updateMessageBody,
    getAllMessages,
    getUnifiedInbox,
    getEverything,
    findMessage,
    findMessageIndex,
    markRead,
    markUnread,
    toggleStar,
    moveMessage,
    applyRules,
  };
}

function extractName(formatted: string): string {
  const match = formatted.match(/^(.+?)\s*<[^>]+>$/);
  return match ? match[1].trim() : formatted;
}

function extractEmail(formatted: string): string {
  const match = formatted.match(/<([^>]+)>$/);
  return match ? match[1].trim() : formatted;
}
