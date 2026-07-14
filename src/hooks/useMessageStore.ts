import { useState } from "react";
import { FOLDERS } from "../data/folders";
import { type SampleMessage, type RealAttachment } from "../data/messages";
import { applyRules as resolveRuleActions, type Rule } from "../lib/rules";
import type { AccountId } from "../theme";
import type { MailAccount } from "../data/accounts";
import type { MessageBody } from "../lib/imap";

// Conversation-thread grouping for one account+folder, built from the
// backend's fetch_threaded_messages and consumed by MessageList's threaded
// render. Keyed by message id (== uid for real mail).
export interface ThreadMeta {
  // Root (conversation-starting) message ids, in no particular order --
  // MessageList sorts them with the active sort key.
  rootIds: number[];
  // Root id -> its descendant ids in depth-first display order (excludes
  // the root itself).
  childrenByRoot: Record<number, number[]>;
  // Any message id -> its nesting depth (0 = root).
  depthById: Record<number, number>;
  // Root id -> total messages in the thread, including the root.
  countByRoot: Record<number, number>;
}

export interface MessageWithFolder extends SampleMessage {
  folder: string;
  accountId: AccountId;
  // Thread-display metadata, set only when the conversation (threaded) view
  // builds its visible row list. Absent in flat view.
  threadDepth?: number;
  threadReplyCount?: number;
  threadRoot?: boolean;
  threadExpanded?: boolean;
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

  // Adds messages (e.g. server-side search hits, or a background poll/IDLE
  // reconciliation) to a folder's list without disturbing those already
  // present -- a message already loaded keeps its existing record (which may
  // have a body fetched), and only genuinely new uids are appended. Used so
  // an IMAP search can surface matches older than the initially-fetched
  // window into the same folder the client-side filter already reads from,
  // and so new mail arriving while a folder is open appends in place instead
  // of replacing the whole list.
  function mergeMessages(account: AccountId, folder: string, incoming: SampleMessage[]) {
    setMessagesByKey((current) => {
      const key = keyFor(account, folder);
      const list = current[key] ?? [];
      const existingIds = new Set(list.map((message) => message.id));
      const additions = incoming.filter((message) => !existingIds.has(message.id));
      // Refresh unread/starred on rows already present: flags change from
      // outside this app (read in webmail, flagged on the phone), and a
      // merge that only appends would leave sorting, badges, and the
      // unread separator working off whatever the flags were at first
      // load. Only flags -- an existing record keeps its fetched body.
      const freshById = new Map(incoming.map((message) => [message.id, message]));
      let flagsChanged = false;
      const refreshed = list.map((message) => {
        const fresh = freshById.get(message.id);
        if (!fresh || (fresh.unread === message.unread && fresh.starred === message.starred)) return message;
        flagsChanged = true;
        return { ...message, unread: fresh.unread, starred: fresh.starred };
      });
      if (additions.length === 0 && !flagsChanged) return current;
      return { ...current, [key]: [...refreshed, ...additions] };
    });
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
      dispositionNotificationTo: body.disposition_notification_to ?? undefined,
      pgpSignedBy: body.pgp_signed_by ?? undefined,
      pgpSignatureValid: body.pgp_signature_valid ?? undefined,
      smimeSigned: body.smime_signed || undefined,
      smimeVerified: body.smime_signed ? body.smime_verified : undefined,
      smimeEncrypted: body.smime_encrypted || undefined,
      smimeSignerEmail: body.smime_signer_email ?? undefined,
      // Overwrite sender/to with the richer body-parsed versions, which
      // include proper display-name extraction by mail_parser rather than
      // the envelope-only format_address from fetch_messages. When the body
      // has no parseable From header, omit these keys entirely rather than
      // patching in `undefined` -- the merge in updateMessage spreads the
      // patch over the existing message, so an explicit `undefined` here
      // would blank out the perfectly valid sender the summary already had.
      ...(body.from ? { sender: extractName(body.from), senderEmail: extractEmail(body.from) } : {}),
      // Keep the full recipient lists (comma-joined -- SampleMessage models
      // them as single strings), not just the first entry: Reply-All and the
      // sender tooltip both need every address, and dropping the rest here
      // silently narrowed multi-recipient mail to one name.
      to: body.to.length > 0 ? body.to.join(", ") : undefined,
      cc: body.cc.length > 0 ? body.cc.join(", ") : undefined,
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

  // Which folders we actually hold messages for, for one account -- derived
  // from the store keys rather than the (lazily-loaded) folder list. Lets
  // offline-search results land in folders that aren't in foldersByAccount
  // yet still surface in the search pool. Account ids are emails, which
  // never contain ':', so the prefix split is unambiguous.
  function storedFoldersFor(account: AccountId): string[] {
    const prefix = `${account}:`;
    return Object.keys(messagesByKey)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  // Per-folder unread counts for the sidebar badges. Returns a flat map keyed
  // by "accountId:folder" containing only entries where the count is > 0.
  function getUnreadCounts(allAccounts: MailAccount[], foldersByAccount: Record<AccountId, string[]>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const acc of allAccounts) {
      for (const folder of foldersByAccount[acc.id] ?? []) {
        const count = getMessages(acc.id, folder).filter((m) => m.unread).length;
        if (count > 0) result[`${acc.id}:${folder}`] = count;
      }
    }
    return result;
  }

  // Every folder of every account -- what the search box reaches when
  // Unified inbox is on. Unions the known folder list with whatever folders
  // the store already holds messages for, so cross-account offline-search
  // hits surface even in folders that were never opened.
  function getEverything(accounts: MailAccount[], foldersByAccount: Record<AccountId, string[]>): MessageWithFolder[] {
    return accounts.flatMap((account) => {
      const known = foldersByAccount[account.id] ?? FOLDERS.map((f) => f.id);
      const folders = Array.from(new Set([...known, ...storedFoldersFor(account.id)]));
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

  // Marks every message in a folder read in one state update -- the local
  // half of "mark all as read" (the server half is mark_folder_seen).
  function markAllRead(account: AccountId, folder: string) {
    setMessagesByKey((current) => {
      const key = keyFor(account, folder);
      const list = current[key];
      if (!list || list.every((message) => !message.unread)) return current;
      return { ...current, [key]: list.map((message) => (message.unread ? { ...message, unread: false } : message)) };
    });
  }

  function setStarred(account: AccountId, folder: string, id: number, starred: boolean) {
    updateMessage(account, folder, id, { starred });
  }

  // --- Batch (multi-select) helpers: one state update for a whole set ---

  function markManyRead(account: AccountId, folder: string, ids: number[], read: boolean) {
    const idSet = new Set(ids);
    setMessagesByKey((current) => {
      const key = keyFor(account, folder);
      const list = current[key];
      if (!list) return current;
      let changed = false;
      const next = list.map((message) => {
        if (idSet.has(message.id) && message.unread === read) {
          changed = true;
          return { ...message, unread: !read };
        }
        return message;
      });
      return changed ? { ...current, [key]: next } : current;
    });
  }

  function starMany(account: AccountId, folder: string, ids: number[], starred: boolean) {
    const idSet = new Set(ids);
    setMessagesByKey((current) => {
      const key = keyFor(account, folder);
      const list = current[key];
      if (!list) return current;
      let changed = false;
      const next = list.map((message) => {
        if (idSet.has(message.id) && message.starred !== starred) {
          changed = true;
          return { ...message, starred };
        }
        return message;
      });
      return changed ? { ...current, [key]: next } : current;
    });
  }

  function moveMany(account: AccountId, fromFolder: string, ids: number[], toFolder: string) {
    if (fromFolder === toFolder) return;
    const idSet = new Set(ids);
    setMessagesByKey((current) => {
      const fromKey = keyFor(account, fromFolder);
      const toKey = keyFor(account, toFolder);
      const fromList = current[fromKey];
      if (!fromList) return current;
      const moving = fromList.filter((message) => idSet.has(message.id));
      if (moving.length === 0) return current;
      const toList = current[toKey] ?? [];
      return {
        ...current,
        [fromKey]: fromList.filter((message) => !idSet.has(message.id)),
        [toKey]: [...moving, ...toList],
      };
    });
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
    mergeMessages,
    updateMessageBody,
    getAllMessages,
    storedFoldersFor,
    getUnifiedInbox,
    getUnreadCounts,
    getEverything,
    findMessage,
    findMessageIndex,
    markRead,
    markUnread,
    markAllRead,
    markManyRead,
    starMany,
    moveMany,
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
