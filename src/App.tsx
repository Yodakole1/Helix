import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { AddAccountModal } from "./components/AddAccountModal";
import { ComposeModal, type ComposePrefill, type MessageTemplate } from "./components/ComposeModal";
import { MessageList } from "./components/MessageList";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { Splitter } from "./components/Splitter";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { resolveAccountColor, type AccountOverrides } from "./data/accounts";
import { formatMessageTime, parseFromField, summaryToMessage, type SampleMessage } from "./data/messages";
import { useAccounts } from "./hooks/useAccounts";
import { useBreakpoint } from "./hooks/useBreakpoint";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMessageStore } from "./hooks/useMessageStore";
import { usePersistedJSON, usePersistedState } from "./hooks/usePersistedState";
import { fetchAttachment, fetchMessageBody, fetchMessages, listFolders, moveMessageToFolder, setMessageFlagged, setMessageSeen } from "./lib/imap";
import { startIdle, stopIdle } from "./lib/idle";
import { flushOutbox, queueForSend } from "./lib/drafts";
import type { Rule } from "./lib/rules";
import { fileToBase64, type OutgoingAttachment } from "./lib/smtp";
import type { WebViewStyle } from "./lib/webStyle";
import type { AccountId } from "./theme";
import { colors, withAlpha } from "./theme";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;
const LIST_MIN = 280;
const LIST_MAX = 520;
const MESSAGES_LIMIT = 50;

export default function App() {
  const { accounts, records, loading: accountsLoading, reload: reloadAccounts } = useAccounts();

  // Welcome screen shows until at least one real account is stored.
  const onboarded = !accountsLoading && accounts.length > 0;

  const [accountId, setAccountId] = useState<AccountId>("");
  const [selectedFolder, setSelectedFolder] = useState<Record<AccountId, string>>({});
  // -1 = nothing selected. Cold start shouldn't reopen "the last message".
  const [selectedId, setSelectedId] = useState(-1);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactList, setCompactList] = useState(false);
  const [unifiedInbox, setUnifiedInbox] = useState(false);
  const [blockImages, setBlockImages] = useState(true);
  const [signature, setSignature] = useState("");
  const [encryptByDefault, setEncryptByDefault] = useState(false);

  // Per-account folder lists from list_folders() -- populated lazily when
  // an account is first activated. Raw IMAP names (e.g. "INBOX", "Sent",
  // "[Gmail]/Sent Mail"), not the normalised sidebar ids.
  const [foldersByAccount, setFoldersByAccount] = useState<Record<AccountId, string[]>>({});

  const [sidebarWidth, setSidebarWidth] = usePersistedState("helix:sidebarWidth", 240);
  const [listWidth, setListWidth] = usePersistedState("helix:listWidth", 360);
  const [accountOverrides, setAccountOverrides] = usePersistedJSON<AccountOverrides>("helix:accountOverrides", {});
  const [templates, setTemplates] = usePersistedJSON<MessageTemplate[]>("helix:templates", []);
  const [rules, setRules] = usePersistedJSON<Rule[]>("helix:rules", []);
  const breakpoint = useBreakpoint();
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "reader">("list");

  useEffect(() => {
    if (breakpoint !== "mobile") setMobileView("list");
    if (breakpoint === "desktop") setSidebarOverlayOpen(false);
  }, [breakpoint]);

  // When real accounts arrive, set the initial active account and selected
  // folder if we don't already have them.
  useEffect(() => {
    if (accounts.length === 0) return;
    if (!accountId || !accounts.find((a) => a.id === accountId)) {
      const first = accounts[0].id;
      setAccountId(first);
      setSelectedFolder((prev) => (prev[first] ? prev : { ...prev, [first]: "INBOX" }));
      ensureFolders(first);
    }
  }, [accounts]);

  function getRecord(forAccountId: AccountId) {
    return records.find((r) => r.account_id === forAccountId);
  }

  // Loads the folder list for an account if we don't have it yet.
  function ensureFolders(forAccountId: AccountId) {
    if (foldersByAccount[forAccountId]) return;
    const rec = getRecord(forAccountId);
    if (!rec) return;
    listFolders(forAccountId, rec.imap_host, rec.imap_port)
      .then((folders) => {
        setFoldersByAccount((prev) => ({ ...prev, [forAccountId]: folders }));
        // Default to INBOX if it exists; some servers spell it differently.
        const inbox = folders.find((f) => f.toUpperCase() === "INBOX") ?? folders[0];
        if (inbox) {
          setSelectedFolder((prev) => (prev[forAccountId] ? prev : { ...prev, [forAccountId]: inbox }));
          loadFolder(forAccountId, inbox);
        }
      })
      .catch((e) => console.warn("list_folders failed for", forAccountId, e));
  }

  // Start IMAP IDLE for each account's INBOX when accounts first load so
  // new-mail events arrive without the user needing to refresh manually.
  useEffect(() => {
    if (!isTauri() || accounts.length === 0) return;

    const unlistenPromise = listen<{ account_id: string; folder: string; new_count: number }>(
      "new-mail",
      ({ payload }) => {
        // Reload whichever account+folder just got new messages. If the
        // affected folder is the currently active one the list refreshes
        // in place; otherwise the count updates silently for when the user
        // switches to it.
        loadFolder(payload.account_id as AccountId, payload.folder);
      },
    );

    for (const account of accounts) {
      const rec = records.find((r) => r.account_id === account.id);
      if (!rec) continue;
      startIdle(account.id, rec.imap_host, rec.imap_port, "INBOX").catch(console.warn);
      flushOutbox(account.id).catch(console.warn);
    }

    return () => {
      unlistenPromise.then((fn) => fn());
      for (const account of accounts) {
        stopIdle(account.id).catch(console.warn);
      }
    };
  }, [accounts.map((a) => a.id).join(",")]);

  // Fetches messages for one account+folder and feeds them into the store.
  function loadFolder(forAccountId: AccountId, folder: string) {
    const rec = getRecord(forAccountId);
    if (!rec) return;
    fetchMessages(forAccountId, rec.imap_host, rec.imap_port, folder, MESSAGES_LIMIT)
      .then((summaries) => {
        const messages = summaries.map((s, i) => summaryToMessage(s, i));
        store.loadMessages(forAccountId, folder, messages);
      })
      .catch((e) => console.warn("fetch_messages failed for", forAccountId, folder, e));
  }

  const accentColor = resolveAccountColor(
    accountOverrides,
    accountId,
    accounts.findIndex((a) => a.id === accountId),
  );

  function handleUpdateAccountOverride(target: AccountId, patch: { label?: string; color?: string }) {
    setAccountOverrides({ ...accountOverrides, [target]: { ...accountOverrides[target], ...patch } });
  }

  function handleSaveTemplate(name: string, subject: string, body: string) {
    setTemplates([...templates, { id: crypto.randomUUID(), name, subject, body }]);
  }

  function handleDeleteTemplate(id: string) {
    setTemplates(templates.filter((template) => template.id !== id));
  }

  function handleSaveRule(rule: Rule) {
    const exists = rules.some((candidate) => candidate.id === rule.id);
    setRules(exists ? rules.map((candidate) => (candidate.id === rule.id ? rule : candidate)) : [...rules, rule]);
  }

  function handleDeleteRule(id: string) {
    setRules(rules.filter((rule) => rule.id !== id));
  }

  const sidebarDragStart = useRef(sidebarWidth);
  const listDragStart = useRef(listWidth);
  const store = useMessageStore();

  useEffect(() => {
    if (!accountId || !selectedFolder[accountId]) return;
    store.applyRules(rules, accountId, selectedFolder[accountId]);
  }, []);

  function selectFirstMessage(forAccountId: AccountId, folder: string) {
    const messages = store.getMessages(forAccountId, folder);
    setSelectedId(messages[0]?.id ?? -1);
  }

  function handleAccountChange(nextAccountId: AccountId) {
    setAccountId(nextAccountId);
    ensureFolders(nextAccountId);
    const folder = selectedFolder[nextAccountId] ?? "INBOX";
    store.applyRules(rules, nextAccountId, folder);
    selectFirstMessage(nextAccountId, folder);
  }

  function handleFolderChange(forAccountId: AccountId, folder: string) {
    setAccountId(forAccountId);
    setSelectedFolder((prev) => ({ ...prev, [forAccountId]: folder }));
    store.applyRules(rules, forAccountId, folder);
    selectFirstMessage(forAccountId, folder);
    // Fetch real messages if we're in the Tauri context and there's a record.
    const rec = getRecord(forAccountId);
    if (rec && store.getMessages(forAccountId, folder).length === 0) {
      loadFolder(forAccountId, folder);
    }
  }

  function handleSelectMessage(id: number, folder: string, messageAccountId: AccountId) {
    if (messageAccountId !== accountId) setAccountId(messageAccountId);
    setSelectedFolder((prev) => (prev[messageAccountId] === folder ? prev : { ...prev, [messageAccountId]: folder }));
    setSelectedId(id);
    if (breakpoint === "mobile") setMobileView("reader");
  }

  // Opening a message marks it read in local state and on the server (best-
  // effort -- a network hiccup shouldn't prevent reading the local copy).
  useEffect(() => {
    if (selectedId === -1 || !accountId || !selectedFolder[accountId]) return;
    const folder = selectedFolder[accountId];
    const message = store.findMessage(accountId, folder, selectedId);
    if (!message) return;

    store.markRead(accountId, folder, selectedId);

    const rec = getRecord(accountId);
    if (rec && message.uid !== undefined) {
      setMessageSeen(accountId, rec.imap_host, rec.imap_port, folder, message.uid, true).catch((e) =>
        console.warn("set_message_seen failed:", e),
      );
    }

    // Fetch the full body if we haven't yet.
    if (!message.bodyLoaded && message.uid !== undefined && rec) {
      fetchMessageBody(accountId, rec.imap_host, rec.imap_port, folder, message.uid)
        .then((body) => store.updateMessageBody(accountId, folder, selectedId, body))
        .catch((e) => console.warn("fetch_message_body failed:", e));
    }
  }, [selectedId, accountId, selectedFolder]);

  function handleToggleStar(id: number) {
    const folder = selectedFolder[accountId];
    const message = store.findMessage(accountId, folder, id);
    if (!message) return;
    const nextStarred = !message.starred;
    store.toggleStar(accountId, folder, id);
    const rec = getRecord(accountId);
    if (rec && message.uid !== undefined) {
      setMessageFlagged(accountId, rec.imap_host, rec.imap_port, folder, message.uid, nextStarred).catch((e) =>
        console.warn("set_message_flagged failed:", e),
      );
    }
  }

  function handleToggleStarInList(id: number, messageAccountId: AccountId, folder: string) {
    const message = store.findMessage(messageAccountId, folder, id);
    if (!message) return;
    const nextStarred = !message.starred;
    store.toggleStar(messageAccountId, folder, id);
    const rec = getRecord(messageAccountId);
    if (rec && message.uid !== undefined) {
      setMessageFlagged(messageAccountId, rec.imap_host, rec.imap_port, folder, message.uid, nextStarred).catch((e) =>
        console.warn("set_message_flagged failed:", e),
      );
    }
  }

  function handleMoveMessage(id: number, toFolder: string) {
    const fromFolder = selectedFolder[accountId];
    const message = store.findMessage(accountId, fromFolder, id);
    store.moveMessage(accountId, fromFolder, id, toFolder);
    if (id === selectedId) setSelectedId(-1);
    const rec = getRecord(accountId);
    if (rec && message?.uid !== undefined) {
      // Use the account's configured archive/trash name when available.
      const destRecord = rec;
      const resolvedDest =
        toFolder === "archive"
          ? destRecord.archive_folder
          : toFolder === "trash"
            ? destRecord.trash_folder
            : toFolder;
      moveMessageToFolder(accountId, rec.imap_host, rec.imap_port, fromFolder, message.uid, resolvedDest).catch((e) =>
        console.warn("move_message_to_folder failed:", e),
      );
    }
  }

  function handleMarkUnread(id: number) {
    const folder = selectedFolder[accountId];
    const message = store.findMessage(accountId, folder, id);
    store.markUnread(accountId, folder, id);
    const rec = getRecord(accountId);
    if (rec && message?.uid !== undefined) {
      setMessageSeen(accountId, rec.imap_host, rec.imap_port, folder, message.uid, false).catch((e) =>
        console.warn("set_message_seen failed:", e),
      );
    }
  }

  async function handleDownloadAttachment(uid: number, attachmentIndex: number) {
    const rec = getRecord(accountId);
    if (!rec) return;
    const folder = selectedFolder[accountId];
    try {
      const content = await fetchAttachment(accountId, rec.imap_host, rec.imap_port, folder, uid, attachmentIndex);
      const bytes = atob(content.content_base64);
      const array = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
      const blob = new Blob([array], { type: content.content_type ?? "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = content.filename ?? "attachment";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn("fetch_attachment failed:", e);
    }
  }

  async function handleSend(
    to: string[],
    ccList: string[],
    subject: string,
    body: string,
    encrypt: boolean,
    attachmentFiles: File[],
    prefill: ComposePrefill | null,
  ): Promise<void> {
    const rec = getRecord(accountId);
    if (!rec) throw new Error("No active account record -- can't send");

    const attachments: OutgoingAttachment[] = await Promise.all(
      attachmentFiles.map(async (file) => ({
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        content_base64: await fileToBase64(file),
      })),
    );

    const toStr = to.join(", ");
    const result = await queueForSend({
      accountId,
      smtpHost: rec.smtp_host,
      smtpPort: rec.smtp_port,
      smtpUseStarttls: rec.smtp_use_starttls,
      to: toStr,
      subject,
      bodyText: body,
      bodyHtml: null,
      attachments,
      inReplyTo: prefill?.inReplyTo ?? null,
      references: prefill?.references ?? [],
      encrypt,
    });
    if (!result.sent && result.outbox_id) {
      throw new Error("Could not send right now -- the message is queued and will be retried automatically.");
    }
  }

  function quoteOf(message: SampleMessage): string {
    return (message.textBody ?? "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  function replySubject(message: SampleMessage): string {
    return message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`;
  }

  function handleReply(message: SampleMessage) {
    const replyTo = message.replyTo
      ? parseFromField(message.replyTo).email
      : message.senderEmail;
    setComposePrefill({
      to: replyTo,
      subject: replySubject(message),
      quote: `On ${formatMessageTime(message.date)}, ${message.sender} wrote:\n${quoteOf(message)}`,
      inReplyTo: message.messageId,
      references: [...(message.references ?? []), ...(message.messageId ? [message.messageId] : [])],
    });
    setComposeOpen(true);
  }

  function handleReplyAll(message: SampleMessage) {
    const replyTo = message.replyTo
      ? parseFromField(message.replyTo).email
      : message.senderEmail;
    setComposePrefill({
      to: replyTo,
      cc: message.cc ? [message.cc] : [],
      subject: replySubject(message),
      quote: `On ${formatMessageTime(message.date)}, ${message.sender} wrote:\n${quoteOf(message)}`,
      inReplyTo: message.messageId,
      references: [...(message.references ?? []), ...(message.messageId ? [message.messageId] : [])],
    });
    setComposeOpen(true);
  }

  function handleForward(message: SampleMessage) {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${message.sender} <${message.senderEmail}>`,
      `Date: ${formatMessageTime(message.date)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to}`,
    ].join("\n");
    setComposePrefill({
      to: "",
      subject: message.subject.toLowerCase().startsWith("fwd:") ? message.subject : `Fwd: ${message.subject}`,
      quote: `${header}\n\n${message.textBody ?? ""}`,
    });
    setComposeOpen(true);
  }

  function handleComposeClose() {
    setComposeOpen(false);
    setComposePrefill(null);
  }

  function handleSidebarDrag(deltaX: number) {
    setSidebarWidth(clamp(sidebarDragStart.current + deltaX, SIDEBAR_MIN, SIDEBAR_MAX));
  }

  function handleListDrag(deltaX: number) {
    setListWidth(clamp(listDragStart.current + deltaX, LIST_MIN, LIST_MAX));
  }

  const currentFolder = selectedFolder[accountId] ?? "INBOX";
  const selectedMessage = store.findMessage(accountId, currentFolder, selectedId);

  const currentFolders = foldersByAccount[accountId] ?? [];

  const [focusSearchSignal, setFocusSearchSignal] = useState(0);
  useKeyboardShortcuts(onboarded && !composeOpen && !settingsOpen && !addAccountOpen, {
    onCompose: () => setComposeOpen(true),
    onReply: () => selectedMessage && handleReply(selectedMessage),
    onReplyAll: () => selectedMessage && handleReplyAll(selectedMessage),
    onForward: () => selectedMessage && handleForward(selectedMessage),
    onArchive: () => selectedId !== -1 && handleMoveMessage(selectedId, "archive"),
    onTrash: () => selectedId !== -1 && handleMoveMessage(selectedId, "trash"),
    onFocusSearch: () => setFocusSearchSignal((value) => value + 1),
    onOpenSettings: () => setSettingsOpen(true),
  });

  const messages = unifiedInbox
    ? store.getUnifiedInbox(accounts)
    : store.getMessages(accountId, currentFolder).map((message) => ({ ...message, folder: currentFolder, accountId }));

  const allAccountMessages = unifiedInbox
    ? store.getEverything(accounts, foldersByAccount)
    : store.getAllMessages(accountId, currentFolders.length > 0 ? currentFolders : [currentFolder]);

  const sidebarProps = {
    accountId,
    accounts,
    accentColor,
    accountOverrides,
    foldersByAccount,
    onUpdateAccountOverride: handleUpdateAccountOverride,
    onAccountChange: handleAccountChange,
    selectedFolder,
    onFolderChange: handleFolderChange,
    onCompose: () => setComposeOpen(true),
    onOpenSettings: () => setSettingsOpen(true),
  };

  const messageListProps = {
    accountId,
    accounts,
    accentColor,
    accountOverrides,
    folder: currentFolder,
    unified: unifiedInbox,
    messages,
    allAccountMessages,
    selectedId,
    onSelect: handleSelectMessage,
    onToggleStar: handleToggleStarInList,
    compact: compactList,
    focusSearchSignal,
    onApplyRules: () => store.applyRules(rules, accountId, currentFolder),
    onRefresh: () => loadFolder(accountId, currentFolder),
  };

  const readerPaneProps = {
    accountId,
    accentColor,
    message: selectedMessage,
    folder: currentFolder,
    avatarIndex: store.findMessageIndex(accountId, currentFolder, selectedId),
    blockImages,
    onToggleStar: handleToggleStar,
    onArchive: (id: number) => handleMoveMessage(id, "archive"),
    onMoveToSpam: (id: number) => handleMoveMessage(id, "spam"),
    onDelete: (id: number) => handleMoveMessage(id, "trash"),
    onMarkUnread: handleMarkUnread,
    onReply: handleReply,
    onReplyAll: handleReplyAll,
    onForward: handleForward,
    onDownloadAttachment: handleDownloadAttachment,
  };

  return (
    <>
      <View style={styles.shell}>
        <View style={styles.glows} pointerEvents="none">
          <View style={[styles.glow, styles.glowCyan]} />
          <View style={[styles.glow, styles.glowPurple]} />
          <View style={[styles.glow, styles.glowGreen]} />
        </View>
        {!onboarded ? (
          <WelcomeScreen accentColor={accentColor || "#00BCD4"} onAddAccount={() => setAddAccountOpen(true)} />
        ) : (
        <View style={styles.panels}>
          {breakpoint === "desktop" && (
            <>
              <Sidebar {...sidebarProps} width={sidebarWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (sidebarDragStart.current = sidebarWidth)}
                onDrag={handleSidebarDrag}
              />
              <MessageList {...messageListProps} width={listWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (listDragStart.current = listWidth)}
                onDrag={handleListDrag}
              />
              <ReaderPane {...readerPaneProps} />
            </>
          )}

          {breakpoint === "tablet" && (
            <>
              <MessageList {...messageListProps} width={listWidth} />
              <Splitter
                accentColor={accentColor}
                onDragStart={() => (listDragStart.current = listWidth)}
                onDrag={handleListDrag}
              />
              <ReaderPane {...readerPaneProps} />
            </>
          )}

          {breakpoint === "mobile" &&
            (mobileView === "list" ? (
              <MessageList {...messageListProps} width="100%" />
            ) : (
              <ReaderPane
                {...readerPaneProps}
                onBack={() => setMobileView("list")}
              />
            ))}

          {breakpoint !== "desktop" && (
            <Pressable
              onPress={() => setSidebarOverlayOpen(true)}
              style={[styles.menuButton, { borderColor: accentColor }]}
            >
              <Text style={[styles.menuButtonText, { color: accentColor }]}>&#9776;</Text>
            </Pressable>
          )}

          {breakpoint !== "desktop" && sidebarOverlayOpen && (
            <Sidebar
              {...sidebarProps}
              width={sidebarWidth}
              overlay
              onDismissOverlay={() => setSidebarOverlayOpen(false)}
            />
          )}
        </View>
        )}
      </View>
      <AddAccountModal
        visible={addAccountOpen}
        accentColor={accentColor || "#00BCD4"}
        onClose={() => setAddAccountOpen(false)}
        onAdded={() => reloadAccounts()}
      />
      <ComposeModal
        visible={composeOpen}
        accentColor={accentColor}
        signature={signature}
        encryptByDefault={encryptByDefault}
        prefill={composePrefill}
        templates={templates}
        onSaveTemplate={handleSaveTemplate}
        onSend={handleSend}
        onClose={handleComposeClose}
        draftContext={(() => {
          const rec = getRecord(accountId);
          if (!rec) return undefined;
          return {
            accountId,
            imapHost: rec.imap_host,
            imapPort: rec.imap_port,
            draftsFolder: "Drafts",
          };
        })()}
      />
      <SettingsModal
        visible={settingsOpen}
        accountId={accountId}
        accounts={accounts}
        accentColor={accentColor}
        accountOverrides={accountOverrides}
        onUpdateAccountOverride={handleUpdateAccountOverride}
        compactList={compactList}
        onToggleCompactList={() => setCompactList((value) => !value)}
        signature={signature}
        onSignatureChange={setSignature}
        encryptByDefault={encryptByDefault}
        onToggleEncryptByDefault={() => setEncryptByDefault((value) => !value)}
        blockImages={blockImages}
        onToggleBlockImages={() => setBlockImages((value) => !value)}
        unifiedInbox={unifiedInbox}
        onToggleUnifiedInbox={() => setUnifiedInbox((value) => !value)}
        onAddAccount={() => setAddAccountOpen(true)}
        templates={templates}
        onDeleteTemplate={handleDeleteTemplate}
        rules={rules}
        onSaveRule={handleSaveRule}
        onDeleteRule={handleDeleteRule}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

const glow: WebViewStyle = {
  position: "absolute",
  width: 680,
  height: 680,
  borderRadius: 340,
  filter: "blur(120px)",
};

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    height: "100%",
    position: "relative",
    overflow: "hidden",
    backgroundColor: colors.background.base,
  },
  glows: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  glow,
  glowCyan: {
    top: -180,
    left: -160,
    backgroundColor: withAlpha(colors.accent.cyan, 0.75),
  },
  glowPurple: {
    top: -140,
    left: 440,
    backgroundColor: withAlpha(colors.accent.purple, 0.65),
  },
  glowGreen: {
    bottom: -300,
    left: 680,
    backgroundColor: withAlpha(colors.accent.green, 0.55),
  },
  panels: {
    flex: 1,
    height: "100%",
    flexDirection: "row",
    position: "relative",
  },
  menuButton: {
    position: "absolute",
    top: 12,
    left: 12,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: colors.background.surface,
    zIndex: 5,
  },
  menuButtonText: {
    fontSize: 14,
  },
});
