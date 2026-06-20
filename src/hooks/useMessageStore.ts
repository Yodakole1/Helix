import { useState } from "react";
import { SEED_MESSAGES_BY_KEY, type SampleMessage } from "../data/messages";
import type { Accent } from "../theme";

function keyFor(account: Accent, folder: string): string {
  return `${account}:${folder}`;
}

// Lifts the (otherwise frozen) sample data into real React state, so
// reading a message, starring it, or moving it to another folder actually
// sticks for the session -- there's still no backend persistence behind
// any of this, same as the rest of the app's sample data.
export function useMessageStore() {
  const [messagesByKey, setMessagesByKey] = useState<Record<string, SampleMessage[]>>(SEED_MESSAGES_BY_KEY);

  function getMessages(account: Accent, folder: string): SampleMessage[] {
    return messagesByKey[keyFor(account, folder)] ?? [];
  }

  function findMessage(account: Accent, folder: string, id: number): SampleMessage | undefined {
    return getMessages(account, folder).find((message) => message.id === id);
  }

  function findMessageIndex(account: Accent, folder: string, id: number): number {
    return getMessages(account, folder).findIndex((message) => message.id === id);
  }

  // Bails out (returns the same object reference) when nothing would
  // actually change, so e.g. calling markRead on an already-read message
  // is a true no-op rather than a fresh array/render every time.
  function updateMessage(account: Accent, folder: string, id: number, patch: Partial<SampleMessage>) {
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

  function markRead(account: Accent, folder: string, id: number) {
    updateMessage(account, folder, id, { unread: false });
  }

  function markUnread(account: Accent, folder: string, id: number) {
    updateMessage(account, folder, id, { unread: true });
  }

  function toggleStar(account: Accent, folder: string, id: number) {
    const message = findMessage(account, folder, id);
    if (!message) return;
    updateMessage(account, folder, id, { starred: !message.starred });
  }

  // Used for archive/spam/trash -- all are just "move this message to a
  // different folder in the same account."
  function moveMessage(account: Accent, fromFolder: string, id: number, toFolder: string) {
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

  return { getMessages, findMessage, findMessageIndex, markRead, markUnread, toggleStar, moveMessage };
}
