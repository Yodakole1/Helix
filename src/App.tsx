import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { AddAccountView } from "./components/AddAccountView";
import { ComposeModal, type ComposePrefill, type MessageTemplate } from "./components/ComposeModal";
import { MessageList } from "./components/MessageList";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { Splitter } from "./components/Splitter";
import { TitleBar, type TabItem } from "./components/TitleBar";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { CalendarView } from "./components/CalendarView";
import { AddressBookView, type AddressBookSource } from "./components/AddressBookView";
import { LockScreen } from "./components/LockScreen";
import { listCardDavSources, type CardDavSource } from "./lib/carddav";
import { getAppLockConfig, type AppLockConfig } from "./lib/lock";
import { icalToIso, listCalDavSources, listCalendarEvents, syncCalDav } from "./lib/caldav";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { resolveAccountColor, type AccountOverrides } from "./data/accounts";
import { folderLabel, normalizeFolderId } from "./data/folders";
import { formatMessageTime, parseFromField, summaryToMessage, type SampleMessage } from "./data/messages";
import { useAccounts } from "./hooks/useAccounts";
import { useBreakpoint } from "./hooks/useBreakpoint";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMessageStore } from "./hooks/useMessageStore";
import { usePersistedJSON, usePersistedState } from "./hooks/usePersistedState";
import { createFolder, deleteFolder, emptyFolder, fetchAttachment, fetchMessageBody, fetchMessages, fetchMessageSource, fetchThreadedMessages, listFolders, markFolderSeen, moveMessagesToFolder, moveMessageToFolder, renameFolder, searchMessages, setMessageFlagged, setMessagesFlagged, setMessageSeen, setMessagesSeen, type ThreadedMessage } from "./lib/imap";
import type { ThreadMeta } from "./hooks/useMessageStore";
import { loadCachedAttachment, loadCachedMessageBody, loadCachedMessages, loadCachedPop3MessageBody, loadCachedPop3Messages, loadCachedPop3Attachment, searchLocalMessages } from "./lib/cache";
import { DEFAULT_FILTERS, type MessageFilters } from "./lib/messageFilters";
import { deleteMessage as deletePop3Message, fetchPop3Message, listMessages, pop3FetchAttachment, pop3SummaryToMessage } from "./lib/pop3";
import { fetchUnifiedInbox, listAccounts as listAccountRecords, reportSpam } from "./lib/account";
import { listIdentities, listMutedThreads, muteThread, unmuteThread, type IdentitySummary } from "./lib/identities";
import { parseIcsInvite, respondToInvite, type InviteInfo } from "./lib/ics";
import { startIdle, stopIdle } from "./lib/idle";
import { cancelQueuedSend, flushOutbox, queueForSend } from "./lib/drafts";
import { trainMessage } from "./lib/bayes";
import { snoozeMessage, listAllSnoozed, listDueSnoozed, cancelSnooze } from "./lib/snooze";
import { UndoSendToast } from "./components/UndoSendToast";
import type { SyncDepth } from "./components/DataStorageSettings";
import type { Rule } from "./lib/rules";
import { fileToBase64, sendMdn, type OutgoingAttachment } from "./lib/smtp";
import { DEFAULT_SHORTCUT_BINDINGS, type ShortcutId } from "./lib/shortcuts";
import type { WebViewStyle } from "./lib/webStyle";
import type { AccountId } from "./theme";
import { colors, withAlpha } from "./theme";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Flattens the backend's nested thread trees into a flat summary list (so
// the store, mutations, and selection keep working on flat messages) plus
// ThreadMeta the MessageList uses to re-group them for display. The flat
// index each summary lands at is the same `fallbackIndex` summaryToMessage
// uses, so the ids in ThreadMeta line up with the stored messages' ids.
function buildThreadData(threads: ThreadedMessage[]): { summaries: ThreadedMessage["message"][]; meta: ThreadMeta } {
  const summaries: ThreadedMessage["message"][] = [];
  const rootIds: number[] = [];
  const childrenByRoot: Record<number, number[]> = {};
  const depthById: Record<number, number> = {};
  const countByRoot: Record<number, number> = {};

  for (const thread of threads) {
    const rootId = thread.message.uid ?? summaries.length;
    rootIds.push(rootId);
    childrenByRoot[rootId] = [];
    let count = 0;

    const walk = (node: ThreadedMessage, depth: number) => {
      const id = node.message.uid ?? summaries.length;
      summaries.push(node.message);
      depthById[id] = depth;
      count += 1;
      if (depth > 0) childrenByRoot[rootId].push(id);
      for (const reply of node.replies) walk(reply, depth + 1);
    };
    walk(thread, 0);
    countByRoot[rootId] = count;
  }

  return { summaries, meta: { rootIds, childrenByRoot, depthById, countByRoot } };
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;
const LIST_MIN = 280;
const LIST_MAX = 520;
const MESSAGES_LIMIT = 50;

// One in-app browser-style tab: an independent view onto the mailbox. Carries
// the whole per-tab navigation slice (see the comment at the `tabs` state).
interface TabState {
  id: string;
  // "mail" tabs show the three-pane layout; "calendar" tabs show
  // CalendarView; "add-account" tabs show the account-onboarding flow;
  // "contacts" tabs show the address book.
  kind?: "mail" | "calendar" | "add-account" | "contacts";
  accountId: AccountId;
  // Per-account "last folder" memory, scoped to this tab so two tabs on the
  // same account can sit on different folders.
  selectedFolder: Record<AccountId, string>;
  selectedId: number;
  unified: boolean;
}

// Render-time fallback for "no tab yet" (before accounts load / tabs init),
// so the derived accountId/selectedId/etc. have safe defaults instead of
// crashing on an undefined active tab.
const EMPTY_TAB: TabState = { id: "", kind: "mail", accountId: "", selectedFolder: {}, selectedId: -1, unified: false };

function makeTab(accountId: AccountId, folder: string, unified = false): TabState {
  return {
    id: crypto.randomUUID(),
    kind: "mail",
    accountId,
    selectedFolder: accountId ? { [accountId]: folder } : {},
    selectedId: -1,
    unified,
  };
}

function makeCalendarTab(): TabState {
  return { id: crypto.randomUUID(), kind: "calendar", accountId: "", selectedFolder: {}, selectedId: -1, unified: false };
}

function makeAddAccountTab(): TabState {
  return { id: crypto.randomUUID(), kind: "add-account", accountId: "", selectedFolder: {}, selectedId: -1, unified: false };
}

function makeContactsTab(): TabState {
  return { id: crypto.randomUUID(), kind: "contacts", accountId: "", selectedFolder: {}, selectedId: -1, unified: false };
}

export default function App() {
  const { accounts, records, loading: accountsLoading, reload: reloadAccounts } = useAccounts();

  // App lock: checked once at startup. null = still checking (render
  // nothing sensitive yet), a config with a method set = show the lock
  // screen until an enrolled method verifies. Unlocking lasts the whole
  // app session -- the lock guards the app start, not each interaction.
  const [lockConfig, setLockConfig] = useState<AppLockConfig | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    getAppLockConfig()
      .then((config) => {
        setLockConfig(config);
        if (!config.password_set && !config.passkey_set) setUnlocked(true);
      })
      .catch(() => setUnlocked(true));
  }, []);
  const locked = !unlocked && lockConfig !== null && (lockConfig.password_set || lockConfig.passkey_set);

  // Welcome screen shows until at least one real account is stored.
  const onboarded = !accountsLoading && accounts.length > 0;

  // Browser-style in-app tabs. Each tab owns its own navigation slice -- the
  // active account, that tab's per-account folder memory, the selected
  // message, and whether it's showing the unified inbox -- so two tabs can
  // sit on different accounts/folders/messages at once and switching between
  // them swaps the whole three-pane view. App-level settings (conversation
  // view, compact list, block images, signature, ...) stay global, shared by
  // every tab; only where you're *looking* is per-tab. The existing
  // accountId/selectedFolder/selectedId/unifiedInbox names below are derived
  // from the active tab and their setters patch it, so the rest of the
  // component reads/writes them unchanged.
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState("");

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? EMPTY_TAB;
  const accountId = activeTab.accountId;
  const selectedFolder = activeTab.selectedFolder;
  // -1 = nothing selected. Cold start shouldn't reopen "the last message".
  const selectedId = activeTab.selectedId;
  const unifiedInbox = activeTab.unified;

  // Patches one field of the active tab. Accepts either a plain value or a
  // React-style updater (so the existing `setSelectedFolder(prev => ...)`
  // call sites keep working), mirroring useState's setter contract.
  function patchActiveTab<K extends keyof TabState>(
    key: K,
    valueOrUpdater: TabState[K] | ((prev: TabState[K]) => TabState[K]),
  ) {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== activeTab.id) return tab;
        const next =
          typeof valueOrUpdater === "function"
            ? (valueOrUpdater as (prev: TabState[K]) => TabState[K])(tab[key])
            : valueOrUpdater;
        return { ...tab, [key]: next };
      }),
    );
  }

  const setAccountId = (value: AccountId | ((prev: AccountId) => AccountId)) =>
    patchActiveTab("accountId", value);
  const setSelectedFolder = (
    value: Record<AccountId, string> | ((prev: Record<AccountId, string>) => Record<AccountId, string>),
  ) => patchActiveTab("selectedFolder", value);
  const setSelectedId = (value: number | ((prev: number) => number)) => patchActiveTab("selectedId", value);
  const setUnifiedInbox = (value: boolean | ((prev: boolean) => boolean)) => patchActiveTab("unified", value);

  // Mail search + structured filters, owned here because the search box
  // lives in the title bar while the filtering happens in the message list.
  const [filters, setFilters] = useState<MessageFilters>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(null);
  // Which account a compose session sends from -- defaults to whatever
  // account is active in the sidebar when compose opens, but can be
  // switched inside the modal (see ComposeModal's account picker) since a
  // user may have many accounts added and want to send from a non-active one.
  const [composeFromAccountId, setComposeFromAccountId] = useState<AccountId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Persisted app settings -- all of these survive a restart (they used to
  // be plain useState, which quietly reset every launch and made the
  // settings screen look broken).
  const [compactList, setCompactList] = usePersistedJSON<boolean>("helix:compactList", false);
  // Conversation (threaded) view toggle, and per-folder thread grouping
  // built from fetch_threaded_messages, keyed by `${accountId}:${folder}`.
  const [conversationView, setConversationView] = usePersistedJSON<boolean>("helix:conversationView", false);
  const [threadsByKey, setThreadsByKey] = useState<Record<string, ThreadMeta>>({});
  const [blockImages, setBlockImages] = usePersistedJSON<boolean>("helix:blockImages", true);
  const [readReceipts, setReadReceipts] = usePersistedJSON<boolean>("helix:readReceipts", false);
  const [allowedImageDomains, setAllowedImageDomains] = usePersistedJSON<string[]>("helix:allowedImageDomains", []);

  function handleAllowImageDomain(domain: string) {
    if (!allowedImageDomains.includes(domain)) {
      setAllowedImageDomains([...allowedImageDomains, domain]);
    }
  }
  const [signature, setSignature] = usePersistedJSON<string>("helix:signature", "");
  const [encryptByDefault, setEncryptByDefault] = usePersistedJSON<boolean>("helix:encryptByDefault", false);
  // Unread messages grouped above read ones in the message list.
  const [separateUnread, setSeparateUnread] = usePersistedJSON<boolean>("helix:separateUnread", false);
  // UI text-size multiplier, applied as a zoom on the document body --
  // react-native-web styles are px-based, so rem tricks don't reach them.
  const [fontScale, setFontScale] = usePersistedJSON<number>("helix:fontScale", 1);
  useEffect(() => {
    (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(fontScale);
  }, [fontScale]);
  // Muted thread root Message-IDs, per-account. Loaded from the cache when
  // the active account changes and updated optimistically on mute/unmute.
  const [mutedByAccount, setMutedByAccount] = useState<Record<AccountId, Set<string>>>({});

  // Snoozed message keys: "${accountId}:${folder}:${uid}" for IMAP,
  // "${accountId}::${pop3Uidl}" for POP3. Messages whose key is in this set
  // are filtered out of the list view until their snooze time is due.
  const [snoozedKeys, setSnoozedKeys] = useState<Set<string>>(new Set());

  // Send-as identities for the active account, loaded when account changes.
  const [identitiesByAccount, setIdentitiesByAccount] = useState<Record<AccountId, IdentitySummary[]>>({});

  // Undo-send toast state: set after queue_for_send returns an outbox_id.
  // Cleared when the toast dismisses (countdown expires or Undo pressed).
  // Carries the sending account (not necessarily the active one) so the
  // flush on dismissal delivers from the right outbox and the right
  // account's Sent folder refreshes afterwards.
  const [undoSendState, setUndoSendState] = useState<{ outboxId: string; accountId: AccountId } | null>(null);
  const UNDO_SEND_WINDOW = 8; // seconds

  // "Headers only" = lazy body fetch on message open (current default behavior).
  // "Bodies" = eager body pre-fetch for the first page of messages after a folder loads.
  const [syncDepth, setSyncDepth] = usePersistedJSON<SyncDepth>("helix:syncDepth", "headers");

  // Per-account folder lists from list_folders() -- populated lazily when
  // an account is first activated. Raw IMAP names (e.g. "INBOX", "Sent",
  // "[Gmail]/Sent Mail"), not the normalised sidebar ids.
  const [foldersByAccount, setFoldersByAccount] = useState<Record<AccountId, string[]>>({});

  const [sidebarWidth, setSidebarWidth] = usePersistedState("helix:sidebarWidth", 240);
  const [listWidth, setListWidth] = usePersistedState("helix:listWidth", 360);
  const [accountOverrides, setAccountOverrides] = usePersistedJSON<AccountOverrides>("helix:accountOverrides", {});
  const [templates, setTemplates] = usePersistedJSON<MessageTemplate[]>("helix:templates", []);
  const [rules, setRules] = usePersistedJSON<Rule[]>("helix:rules", []);
  const [shortcutBindings, setShortcutBindings] = usePersistedJSON<Record<ShortcutId, string>>(
    "helix:shortcutBindings",
    DEFAULT_SHORTCUT_BINDINGS,
  );
  function handleRebindShortcut(id: ShortcutId, combo: string) {
    setShortcutBindings({ ...shortcutBindings, [id]: combo });
  }
  function handleResetShortcuts() {
    setShortcutBindings(DEFAULT_SHORTCUT_BINDINGS);
  }
  const breakpoint = useBreakpoint();
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "reader">("list");

  useEffect(() => {
    if (breakpoint !== "mobile") setMobileView("list");
    if (breakpoint === "desktop") setSidebarOverlayOpen(false);
  }, [breakpoint]);

  // When real accounts arrive, open the first tab (cold start) or repair any
  // tab still pointing at an account that no longer exists (e.g. it was
  // removed), so no tab is left on a dangling account.
  useEffect(() => {
    if (accounts.length === 0) {
      // Keep an in-flight add-account tab alive -- it's exactly how the
      // first account gets added.
      if (tabs.some((tab) => tab.kind !== "add-account")) {
        setTabs((current) => current.filter((tab) => tab.kind === "add-account"));
      }
      return;
    }
    const first = accounts[0].id;
    if (tabs.length === 0) {
      const tab = makeTab(first, "INBOX");
      setTabs([tab]);
      setActiveTabId(tab.id);
      ensureFolders(first);
      return;
    }
    const needsRepair = tabs.some((tab) => !accounts.find((a) => a.id === tab.accountId));
    if (needsRepair) {
      setTabs((current) =>
        current.map((tab) =>
          accounts.find((a) => a.id === tab.accountId)
            ? tab
            : { ...tab, accountId: first, selectedFolder: { [first]: "INBOX" }, selectedId: -1 },
        ),
      );
      ensureFolders(first);
    }
  }, [accounts]);

  // Opens a fresh tab on the active account's inbox and focuses it.
  function openTab() {
    const forAccount = accountId || accounts[0]?.id || "";
    const folder = selectedFolder[forAccount] ?? "INBOX";
    const tab = makeTab(forAccount, folder);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    if (forAccount) ensureFolders(forAccount);
  }

  // Closes a tab. The last remaining tab is never closed (there's always one
  // mailbox view); closing the active tab activates its neighbour.
  function closeTab(tabId: string) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    // Update active ID before updating tab list so both changes batch into
    // one render (calling setState inside a setState updater is unreliable).
    if (tabId === activeTabId) {
      setActiveTabId(next[Math.min(index, next.length - 1)].id);
    }
    setTabs(next);
  }

  function selectTab(tabId: string) {
    setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.accountId) ensureFolders(tab.accountId);
  }

  function openCalendarTab() {
    // Reuse an existing calendar tab if one is already open.
    const existing = tabs.find((t) => t.kind === "calendar");
    if (existing) { setActiveTabId(existing.id); return; }
    const tab = makeCalendarTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  function openContactsTab() {
    const existing = tabs.find((t) => t.kind === "contacts");
    if (existing) { setActiveTabId(existing.id); return; }
    const tab = makeContactsTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  // Which address book the contacts tab shows, chosen from the sidebar.
  const [addressBookKey, setAddressBookKey] = useState("all");
  const [carddavSources, setCarddavSources] = useState<CardDavSource[]>([]);
  useEffect(() => {
    if (activeTab.kind !== "contacts" || !isTauri()) return;
    listCardDavSources().then(setCarddavSources).catch(() => setCarddavSources([]));
  }, [activeTab.kind, activeTab.id]);

  const addressBookSources: AddressBookSource[] = [
    { key: "all", label: "All contacts" },
    { key: "local", label: "Collected locally" },
    ...carddavSources.map((source) => ({
      key: `carddav:${source.id}`,
      label: source.display_name || source.url,
      carddavId: source.id,
    })),
  ];
  const selectedAddressBook =
    addressBookSources.find((source) => source.key === addressBookKey) ?? addressBookSources[0];

  // Account onboarding lives in a full tab (like the calendar), not a
  // blocking modal. Before the first account exists there are no tabs --
  // App renders the view straight over the welcome screen via
  // addAccountOpen instead.
  function openAddAccount() {
    setSettingsOpen(false);
    if (!onboarded) {
      setAddAccountOpen(true);
      return;
    }
    const existing = tabs.find((t) => t.kind === "add-account");
    if (existing) { setActiveTabId(existing.id); return; }
    const tab = makeAddAccountTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  // Which just-added account still needs its folders loaded once its
  // record lands in useAccounts (reload is async, so the record isn't
  // there the moment onDone fires).
  const [pendingAccountFocus, setPendingAccountFocus] = useState<AccountId | null>(null);
  useEffect(() => {
    if (!pendingAccountFocus) return;
    if (!records.find((r) => r.account_id === pendingAccountFocus)) return;
    ensureFolders(pendingAccountFocus);
    setPendingAccountFocus(null);
  }, [records, pendingAccountFocus]);

  // Wraps up the add-account flow: close the onboarding tab/view, focus a
  // fresh mail tab on the new account's inbox, and start loading it.
  function handleAccountAdded(newAccountId: string) {
    setAddAccountOpen(false);
    reloadAccounts();
    setPendingAccountFocus(newAccountId as AccountId);
    const tab = makeTab(newAccountId as AccountId, "INBOX");
    setTabs((current) => [...current.filter((t) => t.kind !== "add-account"), tab]);
    setActiveTabId(tab.id);
  }

  function getRecord(forAccountId: AccountId) {
    return records.find((r) => r.account_id === forAccountId);
  }

  // POP3 accounts have empty imap_* fields and carry the real incoming
  // server in pop3_host/pop3_port. They have no folders, no IMAP UIDs, and
  // none of IMAP's flag/move semantics, so the mailbox paths branch on this.
  function isPop3(rec: { incoming_protocol: string }): boolean {
    return rec.incoming_protocol === "pop3";
  }

  // Loads the folder list for an account if we don't have it yet.
  function ensureFolders(forAccountId: AccountId) {
    if (foldersByAccount[forAccountId]) return;
    const rec = getRecord(forAccountId);
    if (!rec) return;
    // POP3 has no folder concept -- present a single synthetic INBOX so the
    // per-account/per-folder store machinery works unchanged, and load it.
    if (isPop3(rec)) {
      setFoldersByAccount((prev) => ({ ...prev, [forAccountId]: ["INBOX"] }));
      setSelectedFolder((prev) => (prev[forAccountId] ? prev : { ...prev, [forAccountId]: "INBOX" }));
      loadFolder(forAccountId, "INBOX");
      return;
    }
    // Assume "INBOX" (true on effectively every server) and start loading
    // it immediately instead of waiting on the live LIST round trip first --
    // the sidebar's full folder tree fills in once list_folders resolves,
    // but the inbox itself (cache-first, see loadFlatFolder) shouldn't sit
    // blank until then.
    setSelectedFolder((prev) => (prev[forAccountId] ? prev : { ...prev, [forAccountId]: "INBOX" }));
    loadFolder(forAccountId, "INBOX");

    listFolders(forAccountId, rec.imap_host, rec.imap_port)
      .then((folders) => {
        setFoldersByAccount((prev) => ({ ...prev, [forAccountId]: folders }));
        // Only reconcile if the INBOX guess above turns out to be wrong --
        // a non-standard server that spells it differently -- and the user
        // hasn't already navigated to another folder in the meantime.
        if (!folders.some((f) => f.toUpperCase() === "INBOX") && folders[0]) {
          const inbox = folders[0];
          setSelectedFolder((prev) => (prev[forAccountId] === "INBOX" ? { ...prev, [forAccountId]: inbox } : prev));
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

        // Desktop notification for new mail, when the setting is on and the
        // OS permission was granted. Read from localStorage at event time so
        // a toggle in Settings applies without restarting.
        if (localStorage.getItem("helix:notifyNewMail") === "1") {
          isPermissionGranted()
            .then((granted) => {
              if (!granted) return;
              const count = payload.new_count;
              sendNotification({
                title: "New mail",
                body: `${count} new message${count === 1 ? "" : "s"} in ${folderLabel(payload.folder)} (${payload.account_id})`,
              });
            })
            .catch(() => {});
        }
      },
    );

    for (const account of accounts) {
      const rec = records.find((r) => r.account_id === account.id);
      if (!rec) continue;
      // POP3 has no IDLE/push and no IMAP connection to idle on -- skip it.
      if (!isPop3(rec)) {
        startIdle(account.id, rec.imap_host, rec.imap_port, "INBOX").catch(console.warn);
      }
      flushOutbox(account.id).catch(console.warn);
    }

    return () => {
      unlistenPromise.then((fn) => fn());
      for (const account of accounts) {
        const rec = records.find((r) => r.account_id === account.id);
        if (rec && !isPop3(rec)) stopIdle(account.id).catch(console.warn);
      }
    };
  }, [accounts.map((a) => a.id).join(",")]);

  // Fetches messages for one account+folder and feeds them into the store.
  // Branches on the conversation-view toggle: in conversation mode it pulls
  // the server-grouped thread trees (fetch_threaded_messages) and records
  // the grouping the message list re-applies for display; otherwise it does
  // the plain flat fetch. A threaded fetch that fails falls back to the flat
  // path so a server that can't be grouped still shows a usable list.
  function loadFolder(forAccountId: AccountId, folder: string) {
    const rec = getRecord(forAccountId);
    if (!rec) return;
    if (isPop3(rec)) {
      loadPop3Folder(forAccountId);
      return;
    }
    if (conversationView && !unifiedInbox) {
      // Cache-first here too: show the last-cached flat list immediately
      // (regrouping into threads is cheap once the live tree lands) rather
      // than sitting blank while the threaded fetch is in flight.
      let liveLoaded = false;
      loadCachedMessages(forAccountId, folder, MESSAGES_LIMIT)
        .then((summaries) => {
          if (liveLoaded || summaries.length === 0) return;
          store.loadMessages(forAccountId, folder, summaries.map((s, i) => summaryToMessage(s, i)));
        })
        .catch(() => {});

      const key = `${forAccountId}:${folder}`;
      fetchThreadedMessages(forAccountId, rec.imap_host, rec.imap_port, folder, MESSAGES_LIMIT)
        .then((threads) => {
          liveLoaded = true;
          const { summaries, meta } = buildThreadData(threads);
          store.loadMessages(forAccountId, folder, summaries.map((s, i) => summaryToMessage(s, i)));
          setThreadsByKey((prev) => ({ ...prev, [key]: meta }));
        })
        .catch((e) => {
          console.warn("fetch_threaded_messages failed for", forAccountId, folder, e, "-- falling back to flat");
          loadFlatFolder(forAccountId, folder);
        });
      return;
    }
    loadFlatFolder(forAccountId, folder);
  }

  // The flat (non-threaded) fetch. Cache-first: the last-cached summaries
  // render immediately (a folder that's been opened before never sits blank
  // waiting on a network round trip), and the live IMAP fetch that follows
  // reconciles once it lands, win over the cached view unless it lands
  // first. On a live-fetch failure (offline, server down) the cached view
  // simply stays put instead of the mailbox going blank.
  function loadFlatFolder(forAccountId: AccountId, folder: string) {
    const rec = getRecord(forAccountId);
    if (!rec) return;

    let liveLoaded = false;
    loadCachedMessages(forAccountId, folder, MESSAGES_LIMIT)
      .then((summaries) => {
        if (liveLoaded || summaries.length === 0) return;
        store.loadMessages(forAccountId, folder, summaries.map((s, i) => summaryToMessage(s, i)));
      })
      .catch(() => {});

    fetchMessages(forAccountId, rec.imap_host, rec.imap_port, folder, MESSAGES_LIMIT)
      .then((summaries) => {
        liveLoaded = true;
        const messages = summaries.map((s, i) => summaryToMessage(s, i));
        store.loadMessages(forAccountId, folder, messages);
        // Eager body pre-fetch when "bodies" sync depth is selected. Only
        // fires for messages that have a real UID (so they can be fetched)
        // and haven't had their body loaded yet. Best-effort, fires silently.
        if (syncDepth === "bodies") {
          const PREFETCH_LIMIT = 20;
          summaries.slice(0, PREFETCH_LIMIT).forEach((s) => {
            if (!s.uid) return;
            fetchMessageBody(forAccountId, rec.imap_host, rec.imap_port, folder, s.uid)
              .then((body) => store.updateMessageBody(forAccountId, folder, s.uid!, body))
              .catch(() => {});
          });
        }
      })
      .catch((e) => {
        console.warn("fetch_messages failed for", forAccountId, folder, e, "-- keeping cached view");
      });
  }

  // POP3's equivalent of loadFlatFolder, same cache-first/live-reconcile
  // shape. POP3 has no folders (everything is the synthetic INBOX), no
  // UIDs, and no server-side flags -- list_messages returns every message
  // in the maildrop, mapped to unread/unstarred rows keyed by their POP3
  // message number. On network failure, the cached view (keyed by UIDL,
  // though the number in each row may be stale -- body fetches for offline
  // messages use UIDL via pop3Uidl) simply stays put.
  function loadPop3Folder(forAccountId: AccountId) {
    const rec = getRecord(forAccountId);
    if (!rec || !rec.pop3_host || rec.pop3_port == null) return;

    let liveLoaded = false;
    loadCachedPop3Messages(forAccountId, MESSAGES_LIMIT)
      .then((summaries) => {
        if (liveLoaded || summaries.length === 0) return;
        store.loadMessages(forAccountId, "INBOX", summaries.map(pop3SummaryToMessage));
      })
      .catch(() => {});

    listMessages(forAccountId, rec.pop3_host, rec.pop3_port)
      .then((summaries) => {
        liveLoaded = true;
        store.loadMessages(forAccountId, "INBOX", summaries.map(pop3SummaryToMessage));
      })
      .catch((e) => {
        console.warn("list_messages (POP3) failed for", forAccountId, e, "-- keeping cached view");
      });
  }

  // Always re-fetches an account's folder list (unlike ensureFolders, which
  // is a load-once cache), so the sidebar reflects a folder create/rename/
  // delete immediately.
  function refreshFolders(forAccountId: AccountId) {
    const rec = getRecord(forAccountId);
    if (!rec || isPop3(rec)) return;
    listFolders(forAccountId, rec.imap_host, rec.imap_port)
      .then((folders) => setFoldersByAccount((prev) => ({ ...prev, [forAccountId]: folders })))
      .catch((e) => console.warn("list_folders refresh failed:", e));
  }

  function handleCreateFolder(forAccountId: AccountId, name: string) {
    const rec = getRecord(forAccountId);
    if (!rec || isPop3(rec)) return;
    createFolder(forAccountId, rec.imap_host, rec.imap_port, name)
      .then(() => refreshFolders(forAccountId))
      .catch((e) => console.warn("create_folder failed:", e));
  }

  function handleRenameFolder(forAccountId: AccountId, folder: string, newName: string) {
    const rec = getRecord(forAccountId);
    if (!rec || isPop3(rec)) return;
    renameFolder(forAccountId, rec.imap_host, rec.imap_port, folder, newName)
      .then(() => refreshFolders(forAccountId))
      .catch((e) => console.warn("rename_folder failed:", e));
  }

  function handleDeleteFolder(forAccountId: AccountId, folder: string) {
    const rec = getRecord(forAccountId);
    if (!rec || isPop3(rec)) return;
    deleteFolder(forAccountId, rec.imap_host, rec.imap_port, folder)
      .then(() => refreshFolders(forAccountId))
      .catch((e) => console.warn("delete_folder failed:", e));
  }

  function handleEmptyFolder(forAccountId: AccountId, folder: string) {
    const rec = getRecord(forAccountId);
    if (!rec || isPop3(rec)) return;
    emptyFolder(forAccountId, rec.imap_host, rec.imap_port, folder)
      .then(() => loadFolder(forAccountId, folder))
      .catch((e) => console.warn("empty_folder failed:", e));
  }

  // Calendar event reminders: check the cached CalDAV events every minute
  // and fire a desktop notification when an event's start time enters the
  // configured lead window. Settings are read from localStorage per tick so
  // changes apply live; each event only ever notifies once per app run.
  const notifiedEventsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isTauri()) return;

    async function checkReminders() {
      if (localStorage.getItem("helix:calendarReminders") === "false") return;
      const storedLead = Number(localStorage.getItem("helix:reminderLeadMinutes"));
      const leadMs = (Number.isFinite(storedLead) && storedLead > 0 ? storedLead : 10) * 60_000;
      try {
        if (!(await isPermissionGranted())) return;
        const events = await listCalendarEvents();
        const now = Date.now();
        for (const event of events) {
          const iso = icalToIso(event.dtstart);
          if (!iso || !iso.includes("T")) continue; // all-day events have no start time to remind at
          const start = new Date(iso).getTime();
          if (Number.isNaN(start)) continue;
          const key = `${event.source_id}:${event.uid}:${event.dtstart}`;
          if (start <= now || start - now > leadMs || notifiedEventsRef.current.has(key)) continue;
          notifiedEventsRef.current.add(key);
          const at = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          sendNotification({
            title: "Upcoming event",
            body: `${event.summary ?? "(untitled event)"} at ${at}${event.location ? ` -- ${event.location}` : ""}`,
          });
        }
      } catch (e) {
        console.warn("calendar reminder check failed:", e);
      }
    }

    // Keep the cached events fresh enough for reminders to be trustworthy:
    // re-sync every CalDAV source on a slow beat, check reminders on a fast one.
    async function syncAllSources() {
      try {
        const sources = await listCalDavSources();
        for (const source of sources) syncCalDav(source.id).catch(() => {});
      } catch {
        // no sources / backend unreachable -- reminders just use the cache
      }
    }

    checkReminders();
    syncAllSources();
    const reminderTimer = setInterval(checkReminders, 60_000);
    const syncTimer = setInterval(syncAllSources, 15 * 60_000);
    return () => {
      clearInterval(reminderTimer);
      clearInterval(syncTimer);
    };
  }, []);

  // Load muted threads for the active account whenever it changes so the
  // mute indicator in the reader pane reflects the real persisted state.
  useEffect(() => {
    if (!accountId || !isTauri()) return;
    listMutedThreads(accountId)
      .then((ids) => setMutedByAccount((prev) => ({ ...prev, [accountId]: new Set(ids) })))
      .catch(console.warn);
  }, [accountId]);

  // Load all active snoozes for this account on login / account switch, and
  // immediately cancel (un-snooze) any that are already past their due time.
  useEffect(() => {
    if (!accountId || !isTauri()) return;
    listAllSnoozed(accountId)
      .then((all) => {
        setSnoozedKeys((prev) => {
          const next = new Set(prev);
          all.forEach((s) => {
            if (s.uid != null) next.add(`${s.account_id}:${s.folder}:${s.uid}`);
            else if (s.pop3_uidl) next.add(`${s.account_id}::${s.pop3_uidl}`);
          });
          return next;
        });
      })
      .catch(console.warn);
    listDueSnoozed()
      .then((due) => {
        if (due.length === 0) return;
        setSnoozedKeys((prev) => {
          const next = new Set(prev);
          due.forEach((s) => {
            if (s.uid != null) next.delete(`${s.account_id}:${s.folder}:${s.uid}`);
            else if (s.pop3_uidl) next.delete(`${s.account_id}::${s.pop3_uidl}`);
          });
          return next;
        });
        due.forEach((s) => cancelSnooze(s.id).catch(console.warn));
      })
      .catch(console.warn);
  }, [accountId]);

  // Load send-as identities for the active account so the compose From:
  // picker is populated with the real alias list.
  useEffect(() => {
    if (!accountId || !isTauri()) return;
    listIdentities(accountId)
      .then((ids) => setIdentitiesByAccount((prev) => ({ ...prev, [accountId]: ids })))
      .catch(console.warn);
  }, [accountId]);

  // Switching the conversation-view toggle on re-fetches the current folder
  // grouped into threads (turning it off just renders the same store rows
  // flat, no refetch needed). Skipped in the unified inbox, which spans
  // accounts/folders the per-folder thread grouping doesn't model.
  useEffect(() => {
    if (!conversationView || unifiedInbox || !accountId) return;
    loadFolder(accountId, selectedFolder[accountId] ?? "INBOX");
  }, [conversationView]);

  // Turning the unified inbox on fans fetch_messages out across every stored
  // IMAP account's INBOX in one backend call, so accounts the user never
  // opened individually still contribute to the merged view. Results are
  // merged (not replaced) into each account's INBOX so any already-fetched
  // bodies survive. Best-effort -- a failure leaves whatever's already in the
  // store, which the client-side merge (getUnifiedInbox) still renders.
  useEffect(() => {
    if (!unifiedInbox || !isTauri() || accounts.length === 0) return;
    fetchUnifiedInbox(MESSAGES_LIMIT)
      .then((results) => {
        const byAccount = new Map<AccountId, SampleMessage[]>();
        results.forEach((r, i) => {
          const list = byAccount.get(r.account_id) ?? [];
          list.push(summaryToMessage(r, i));
          byAccount.set(r.account_id, list);
        });
        for (const [account, messages] of byAccount.entries()) {
          store.mergeMessages(account, "INBOX", messages);
        }
      })
      .catch((e) => console.warn("fetch_unified_inbox failed:", e));
  }, [unifiedInbox, accounts.map((a) => a.id).join(",")]);

  // Calendar tabs carry no accountId (a calendar isn't scoped to one
  // account) -- fall back to the first account's color rather than
  // resolving against a "" id / -1 index, so the calendar's buttons match
  // the same theme as the mail view instead of jumping to an unrelated
  // rotation color.
  const accountIdForColor = accountId || accounts[0]?.id || "";
  const accentColor = resolveAccountColor(
    accountOverrides,
    accountIdForColor,
    accounts.findIndex((a) => a.id === accountIdForColor),
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

    // POP3 has no server-side \Seen flag and addresses messages by their
    // session number, not a UID -- fetch the body by number, no seen update.
    // Cache-first, same shape as the IMAP path below: a previously-opened
    // message (keyed by its stable UIDL, unlike the session-specific
    // number) shows instantly instead of waiting on a live RETR.
    if (rec && isPop3(rec) && message.pop3Number !== undefined) {
      if (!message.bodyLoaded && rec.pop3_host && rec.pop3_port != null) {
        let liveLoaded = false;
        if (message.pop3Uidl) {
          loadCachedPop3MessageBody(accountId, message.pop3Uidl)
            .then((body) => {
              if (!liveLoaded && body) store.updateMessageBody(accountId, folder, selectedId, body);
            })
            .catch(() => {});
        }
        fetchPop3Message(accountId, rec.pop3_host, rec.pop3_port, message.pop3Number)
          .then((body) => {
            liveLoaded = true;
            store.updateMessageBody(accountId, folder, selectedId, body);
          })
          .catch((e) => console.warn("fetch_message (POP3) failed:", e, "-- keeping cached body"));
      }
      return;
    }

    if (rec && message.uid !== undefined) {
      setMessageSeen(accountId, rec.imap_host, rec.imap_port, folder, message.uid, true).catch((e) =>
        console.warn("set_message_seen failed:", e),
      );
    }

    // Fetch the full body if we haven't yet. Cache-first: a message that's
    // been opened before (or eagerly pre-fetched, see the "bodies" sync
    // depth setting) renders immediately from the local cache while the
    // live fetch reconciles in the background, rather than every open
    // sitting blank on a fresh SELECT+FETCH round trip.
    if (!message.bodyLoaded && message.uid !== undefined && rec) {
      const uid = message.uid;
      let liveLoaded = false;
      loadCachedMessageBody(accountId, folder, uid)
        .then((body) => {
          if (!liveLoaded && body) store.updateMessageBody(accountId, folder, selectedId, body);
        })
        .catch(() => {});

      fetchMessageBody(accountId, rec.imap_host, rec.imap_port, folder, uid)
        .then((body) => {
          liveLoaded = true;
          store.updateMessageBody(accountId, folder, selectedId, body);
        })
        .catch((e) => console.warn("fetch_message_body failed:", e, "-- keeping cached body"));
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

  // Resolves a symbolic destination ("archive"/"trash"/"spam") or a bare
  // folder name to the real folder the account has, so the optimistic local
  // move lands under the same store key the destination folder's list view
  // reads from -- otherwise the message only appears there after a refetch
  // (or never, when the store key doesn't match any real folder).
  function resolveDestFolder(forAccountId: AccountId, dest: string): string {
    const rec = getRecord(forAccountId);
    const configured =
      dest === "archive" ? rec?.archive_folder
      : dest === "trash" ? rec?.trash_folder
      : dest === "spam" ? rec?.spam_folder
      : dest;
    const folders = foldersByAccount[forAccountId] ?? [];
    if (configured && folders.includes(configured)) return configured;
    const target = normalizeFolderId(configured ?? dest);
    return folders.find((f) => normalizeFolderId(f) === target) ?? configured ?? dest;
  }

  // Reloads the sending account's Sent folder after a send is flushed, so
  // the just-sent message shows up without a manual refresh. Re-reads the
  // account records first: append_to_sent may have just healed a wrong
  // sent-folder name (e.g. "Sent" -> "INBOX.Sent") and the refresh needs
  // the corrected name.
  async function refreshSentFolder(forAccountId: AccountId) {
    if (!isTauri()) return;
    try {
      const recs = await listAccountRecords();
      const rec = recs.find((r) => r.account_id === forAccountId);
      if (!rec || isPop3(rec)) return;
      reloadAccounts();
      loadFolder(forAccountId, rec.sent_folder);
    } catch (e) {
      console.warn("could not refresh sent folder:", e);
    }
  }

  function handleMoveMessage(id: number, toFolder: string) {
    const fromFolder = selectedFolder[accountId];
    const message = store.findMessage(accountId, fromFolder, id);
    store.moveMessage(accountId, fromFolder, id, resolveDestFolder(accountId, toFolder));
    if (id === selectedId) setSelectedId(-1);
    const rec = getRecord(accountId);
    // POP3 has no folders to move between -- the only server-side mutation
    // it supports is deletion, so "trash" deletes from the maildrop and
    // archive/spam stay local-only (the row already moved in the store).
    if (rec && isPop3(rec)) {
      if (toFolder === "trash" && message?.pop3Number !== undefined && rec.pop3_host && rec.pop3_port != null) {
        deletePop3Message(accountId, rec.pop3_host, rec.pop3_port, message.pop3Number).catch((e) =>
          console.warn("delete_message (POP3) failed:", e),
        );
      }
      return;
    }
    if (rec && message?.uid !== undefined) {
      const uid = message.uid;
      if (toFolder === "spam") {
        // report_spam tags $Junk and moves to the configured spam folder.
        reportSpam(accountId, rec.imap_host, rec.imap_port, fromFolder, uid).catch((e) =>
          console.warn("report_spam failed:", e),
        );
        // Train the Bayesian classifier on this message as spam.
        trainMessage(message?.textBody ?? message?.preview ?? "", true).catch(console.warn);
      } else {
        const resolvedDest =
          toFolder === "archive"
            ? rec.archive_folder
            : toFolder === "trash"
              ? rec.trash_folder
              : toFolder;
        moveMessageToFolder(accountId, rec.imap_host, rec.imap_port, fromFolder, uid, resolvedDest).catch((e) =>
          console.warn("move_message_to_folder failed:", e),
        );
      }
    }
  }

  // Moves the message back to INBOX and tells the Bayesian classifier it was
  // incorrectly classified. Only callable from the spam folder banner.
  function handleNotSpam(id: number) {
    const fromFolder = selectedFolder[accountId];
    const message = store.findMessage(accountId, fromFolder, id);
    handleMoveMessage(id, "INBOX");
    trainMessage(message?.textBody ?? message?.preview ?? "", false).catch(console.warn);
  }

  // Stores a snooze record in the backend and hides the message from the list
  // until the due time. The message stays on the IMAP server -- snooze is a
  // purely local annotation, not a server-side folder move.
  function handleSnooze(id: number, until: string) {
    const folder = selectedFolder[accountId];
    const message = store.findMessage(accountId, folder, id);
    if (!message) return;
    snoozeMessage({
      accountId,
      folder,
      uid: message.uid ?? null,
      pop3Uidl: message.pop3Uidl ?? null,
      subject: message.subject,
      sender: message.sender,
      snoozeUntil: until,
    }).catch(console.warn);
    const key = message.uid != null
      ? `${accountId}:${folder}:${message.uid}`
      : message.pop3Uidl
        ? `${accountId}::${message.pop3Uidl}`
        : null;
    if (key) setSnoozedKeys((prev) => new Set([...prev, key]));
    if (id === selectedId) setSelectedId(-1);
  }

  // Search runs two complementary queries, both merged into the store so the
  // existing client-side filter surfaces the extra hits:
  //
  //  1. Offline/global FTS over the encrypted cache (search_local_messages):
  //     no network, spans every cached account+folder (scoped to the active
  //     account when not in the unified inbox, every account when unified),
  //     and finds matches older than the live fetch window or in folders that
  //     aren't open. Results land in their own (account, folder) bucket.
  //  2. Live IMAP search of the active folder (IMAP accounts only): catches
  //     matches that were never cached. Skipped in the unified view (it's
  //     per-folder) and for POP3 (no server-side search).
  //
  // Both are best-effort -- a failure just leaves the other source's hits and
  // the client-side filter over already-loaded messages in place.
  function handleSearch(query: string, structuredFilters?: { fromFilter?: string; isUnread?: boolean | null; isFlagged?: boolean | null; hasAttachment?: boolean | null }) {
    const localScope = unifiedInbox ? null : accountId;
    searchLocalMessages(localScope, query, MESSAGES_LIMIT, structuredFilters)
      .then((results) => {
        // Group hits by their own account+folder before merging, so one
        // mergeMessages call covers each bucket rather than one per hit.
        const byKey = new Map<string, { account: AccountId; folder: string; messages: SampleMessage[] }>();
        results.forEach((r, i) => {
          const key = `${r.account_id}|${r.folder}`;
          const bucket = byKey.get(key) ?? { account: r.account_id, folder: r.folder, messages: [] };
          bucket.messages.push(summaryToMessage(r, i));
          byKey.set(key, bucket);
        });
        for (const { account, folder, messages } of byKey.values()) {
          store.mergeMessages(account, folder, messages);
        }
      })
      .catch((e) => console.warn("search_local_messages failed:", e));

    if (unifiedInbox) return; // live IMAP search is per-folder; unified relies on the local search above
    const rec = getRecord(accountId);
    if (!rec || isPop3(rec)) return; // POP3 has no server-side search
    const folder = currentFolder;
    searchMessages(accountId, rec.imap_host, rec.imap_port, folder, query, MESSAGES_LIMIT)
      .then((summaries) => {
        store.mergeMessages(accountId, folder, summaries.map((s, i) => summaryToMessage(s, i)));
      })
      .catch((e) => console.warn("search_messages failed:", e));
  }

  function handleMarkAllRead() {
    const folder = selectedFolder[accountId];
    store.markAllRead(accountId, folder);
    const rec = getRecord(accountId);
    if (rec && !isPop3(rec)) {
      markFolderSeen(accountId, rec.imap_host, rec.imap_port, folder, true).catch((e) =>
        console.warn("mark_folder_seen failed:", e),
      );
    }
  }

  function resolveUids(folder: string, ids: number[]): number[] {
    return ids
      .map((id) => store.findMessage(accountId, folder, id)?.uid)
      .filter((uid): uid is number => uid !== undefined);
  }

  function handleBatchMarkRead(ids: number[], read: boolean) {
    const folder = selectedFolder[accountId];
    store.markManyRead(accountId, folder, ids, read);
    const rec = getRecord(accountId);
    const uids = resolveUids(folder, ids);
    if (rec && uids.length > 0) {
      setMessagesSeen(accountId, rec.imap_host, rec.imap_port, folder, uids, read).catch((e) =>
        console.warn("set_messages_seen failed:", e),
      );
    }
  }

  function handleBatchStar(ids: number[], starred: boolean) {
    const folder = selectedFolder[accountId];
    store.starMany(accountId, folder, ids, starred);
    const rec = getRecord(accountId);
    const uids = resolveUids(folder, ids);
    if (rec && uids.length > 0) {
      setMessagesFlagged(accountId, rec.imap_host, rec.imap_port, folder, uids, starred).catch((e) =>
        console.warn("set_messages_flagged failed:", e),
      );
    }
  }

  function handleBatchMove(ids: number[], dest: "archive" | "trash") {
    const folder = selectedFolder[accountId];
    const rec = getRecord(accountId);
    // Resolve uids BEFORE the local move removes these rows from the folder.
    const uids = resolveUids(folder, ids);
    store.moveMany(accountId, folder, ids, resolveDestFolder(accountId, dest));
    if (ids.includes(selectedId)) setSelectedId(-1);
    if (rec && uids.length > 0) {
      const resolvedDest = dest === "archive" ? rec.archive_folder : rec.trash_folder;
      moveMessagesToFolder(accountId, rec.imap_host, rec.imap_port, folder, uids, resolvedDest).catch((e) =>
        console.warn("move_messages_to_folder failed:", e),
      );
    }
  }

  // Fetches a text/calendar attachment and parses it into structured invite
  // data. Same fetch path as handleDownloadAttachment; parse_ics_invite runs
  // on the base64 bytes without needing to decode them first.
  async function handleFetchInvite(uidOrNumber: number, attachmentIndex: number): Promise<InviteInfo> {
    const rec = getRecord(accountId);
    if (!rec) throw new Error("No active account record");
    const folder = selectedFolder[accountId] ?? "INBOX";
    const content =
      isPop3(rec) && rec.pop3_host && rec.pop3_port != null
        ? await pop3FetchAttachment(accountId, rec.pop3_host, rec.pop3_port, uidOrNumber, attachmentIndex)
        : await fetchAttachment(accountId, rec.imap_host, rec.imap_port, folder, uidOrNumber, attachmentIndex);
    return parseIcsInvite(content.content_base64);
  }

  async function handleRespondToInvite(
    invite: InviteInfo,
    response: "accept" | "decline" | "tentative",
  ): Promise<void> {
    const rec = getRecord(accountId);
    if (!rec) throw new Error("No active account record");
    if (!invite.uid || !invite.organizer) throw new Error("Invite is missing a UID or organizer address");
    await respondToInvite({
      accountId,
      smtpHost: rec.smtp_host,
      smtpPort: rec.smtp_port,
      smtpUseStarttls: rec.smtp_use_starttls,
      organizerEmail: invite.organizer,
      inviteUid: invite.uid,
      summary: invite.summary,
      dtstart: invite.start,
      dtend: invite.end,
      response,
    });
  }

  function handleMuteThread(messageId: string, muted: boolean) {
    // Optimistic update -- toggle in local state immediately, then sync to backend.
    setMutedByAccount((prev) => {
      const current = new Set(prev[accountId] ?? []);
      if (muted) {
        current.add(messageId);
      } else {
        current.delete(messageId);
      }
      return { ...prev, [accountId]: current };
    });
    const op = muted ? muteThread : unmuteThread;
    op(accountId, messageId).catch((e) => console.warn("mute_thread failed:", e));
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

  // The first arg is the IMAP UID for IMAP accounts and the POP3 message
  // number for POP3 accounts (ReaderPane passes whichever the message has).
  // Falls back to the cached copy for IMAP when offline.
  async function handleDownloadAttachment(uidOrNumber: number, attachmentIndex: number) {
    const rec = getRecord(accountId);
    if (!rec) return;
    const folder = selectedFolder[accountId];

    function triggerDownload(content: { content_base64: string; content_type: string | null; filename: string | null }) {
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
    }

    const selectedMsg = store.findMessage(accountId, selectedFolder[accountId] ?? "INBOX", selectedId);
    try {
      if (isPop3(rec) && rec.pop3_host && rec.pop3_port != null) {
        const content = await pop3FetchAttachment(accountId, rec.pop3_host, rec.pop3_port, uidOrNumber, attachmentIndex)
          .catch(async (liveErr) => {
            const uidl = selectedMsg?.pop3Uidl;
            if (!uidl) throw liveErr;
            console.warn("pop3_fetch_attachment failed:", liveErr, "-- trying cache");
            const cached = await loadCachedPop3Attachment(accountId, uidl, attachmentIndex);
            if (!cached) throw liveErr;
            return cached;
          });
        triggerDownload(content);
      } else {
        const content = await fetchAttachment(accountId, rec.imap_host, rec.imap_port, folder, uidOrNumber, attachmentIndex)
          .catch(async (liveErr) => {
            console.warn("fetch_attachment failed:", liveErr, "-- trying cache");
            const cached = await loadCachedAttachment(accountId, folder, uidOrNumber, attachmentIndex);
            if (!cached) throw liveErr;
            return cached;
          });
        triggerDownload(content);
      }
    } catch (e) {
      console.warn("fetch_attachment failed (no cache fallback):", e);
    }
  }

  async function handleSend(
    to: string[],
    ccList: string[],
    bccList: string[],
    subject: string,
    body: string,
    encrypt: boolean,
    attachmentFiles: File[],
    prefill: ComposePrefill | null,
    fromOverride: string | null,
    sendAt: string | null,
    htmlBody?: string | null,
  ): Promise<void> {
    // The account chosen in ComposeModal's From picker, not necessarily the
    // one active in the sidebar -- a user with multiple accounts can send
    // as any of them.
    const sendingAccountId = composeFromAccountId ?? accountId;
    const rec = getRecord(sendingAccountId);
    if (!rec) throw new Error("No active account record -- can't send");

    const attachments: OutgoingAttachment[] = await Promise.all(
      attachmentFiles.map(async (file) => ({
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        content_base64: await fileToBase64(file),
      })),
    );

    // If no explicit send-at (Send Later) was chosen, use a short undo-send
    // window so the user can cancel the message after clicking Send.
    const effectiveSendAt = sendAt ?? (() => {
      const t = new Date();
      t.setSeconds(t.getSeconds() + UNDO_SEND_WINDOW);
      return t.toISOString();
    })();

    const result = await queueForSend({
      accountId: sendingAccountId,
      smtpHost: rec.smtp_host,
      smtpPort: rec.smtp_port,
      smtpUseStarttls: rec.smtp_use_starttls,
      to: to.join(", "),
      cc: ccList.join(", "),
      bcc: bccList.join(", "),
      subject,
      bodyText: body,
      bodyHtml: htmlBody ?? null,
      attachments,
      inReplyTo: prefill?.inReplyTo ?? null,
      references: prefill?.references ?? [],
      encrypt,
      sendAt: effectiveSendAt,
      fromOverride,
    });
    // The message is queued (deferred by sendAt). Show the undo toast; when
    // it expires the toast calls flushOutbox to deliver the message.
    if (result.outbox_id) {
      setUndoSendState({ outboxId: result.outbox_id, accountId: sendingAccountId });
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
    setComposeFromAccountId(accountId);
    setComposeOpen(true);
  }

  function handleReplyAll(message: SampleMessage) {
    const replyTo = message.replyTo
      ? parseFromField(message.replyTo).email
      : message.senderEmail;
    // Strip own address from Cc so we don't send to ourselves.
    const ownEmail = accountId.toLowerCase();
    const ccList = (message.cc ? [message.cc] : []).filter(
      (addr) => parseFromField(addr).email.toLowerCase() !== ownEmail,
    );
    setComposePrefill({
      to: replyTo,
      cc: ccList,
      subject: replySubject(message),
      quote: `On ${formatMessageTime(message.date)}, ${message.sender} wrote:\n${quoteOf(message)}`,
      inReplyTo: message.messageId,
      references: [...(message.references ?? []), ...(message.messageId ? [message.messageId] : [])],
    });
    setComposeFromAccountId(accountId);
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
    setComposeFromAccountId(accountId);
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

  // A stale "from: x" filter silently emptying an unrelated folder you just
  // switched into would be confusing -- clear search/filters whenever the
  // active mailbox changes (which includes switching tabs).
  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
    setFiltersOpen(false);
  }, [accountId, currentFolder]);

  // Ctrl+Tab / Ctrl+Shift+Tab cycle through tabs, browser-style. Registered
  // directly (not via useKeyboardShortcuts) so it also works while typing
  // in an input -- the same way browsers treat it as window chrome.
  useEffect(() => {
    function handleTabSwitch(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key !== "Tab") return;
      event.preventDefault();
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.id === activeTab.id);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next) selectTab(next.id);
    }
    window.addEventListener("keydown", handleTabSwitch);
    return () => window.removeEventListener("keydown", handleTabSwitch);
  }, [tabs, activeTab.id]);

  const messages = (unifiedInbox
    ? store.getUnifiedInbox(accounts)
    : store.getMessages(accountId, currentFolder).map((message) => ({ ...message, folder: currentFolder, accountId }))
  ).filter((m) => {
    const key = m.uid != null
      ? `${m.accountId}:${m.folder}:${m.uid}`
      : m.pop3Uidl
        ? `${m.accountId}::${m.pop3Uidl}`
        : null;
    return key === null || !snoozedKeys.has(key);
  });

  useKeyboardShortcuts(onboarded && !composeOpen && !settingsOpen && !addAccountOpen, shortcutBindings, {
    compose: () => { setComposeFromAccountId(accountId); setComposeOpen(true); },
    reply: () => selectedMessage && handleReply(selectedMessage),
    replyAll: () => selectedMessage && handleReplyAll(selectedMessage),
    forward: () => selectedMessage && handleForward(selectedMessage),
    archive: () => selectedId !== -1 && handleMoveMessage(selectedId, "archive"),
    trash: () => selectedId !== -1 && handleMoveMessage(selectedId, "trash"),
    star: () => selectedId !== -1 && handleToggleStar(selectedId),
    markUnread: () => selectedId !== -1 && handleMarkUnread(selectedId),
    markAllRead: () => handleMarkAllRead(),
    refresh: () => loadFolder(accountId, currentFolder),
    nextMessage: () => {
      if (messages.length === 0) return;
      const index = messages.findIndex((m) => m.id === selectedId);
      const next = messages[index + 1] ?? messages[0];
      if (next) handleSelectMessage(next.id, next.folder, next.accountId);
    },
    prevMessage: () => {
      if (messages.length === 0) return;
      const index = messages.findIndex((m) => m.id === selectedId);
      const prev = index <= 0 ? messages[messages.length - 1] : messages[index - 1];
      if (prev) handleSelectMessage(prev.id, prev.folder, prev.accountId);
    },
    focusSearch: () => setFocusSearchSignal((value) => value + 1),
    openSettings: () => setSettingsOpen(true),
  });

  const allAccountMessages = unifiedInbox
    ? store.getEverything(accounts, foldersByAccount)
    : store.getAllMessages(
        accountId,
        // Union the known folder list with any folder the store already holds
        // messages for, so offline-search hits in not-yet-opened folders show.
        Array.from(
          new Set([
            ...(currentFolders.length > 0 ? currentFolders : [currentFolder]),
            ...store.storedFoldersFor(accountId),
          ]),
        ),
      );

  const sidebarProps = {
    accountId,
    accounts,
    accentColor,
    accountOverrides,
    foldersByAccount,
    unreadCounts: store.getUnreadCounts(accounts, foldersByAccount),
    onUpdateAccountOverride: handleUpdateAccountOverride,
    onAccountChange: handleAccountChange,
    selectedFolder,
    onFolderChange: handleFolderChange,
    onCreateFolder: handleCreateFolder,
    onRenameFolder: handleRenameFolder,
    onDeleteFolder: handleDeleteFolder,
    onEmptyFolder: handleEmptyFolder,
    onCompose: () => { setComposeFromAccountId(accountId); setComposeOpen(true); },
    onOpenCalendar: openCalendarTab,
    onOpenContacts: openContactsTab,
    onOpenSettings: () => setSettingsOpen(true),
    showAccountList: activeTab.kind !== "calendar" && activeTab.kind !== "contacts",
    contactsMode: activeTab.kind === "contacts",
    addressBookSources,
    selectedAddressBookKey: selectedAddressBook.key,
    onSelectAddressBook: setAddressBookKey,
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
    filters,
    separateUnread,
    onMarkAllRead: handleMarkAllRead,
    onSearch: handleSearch,
    // Multi-select acts on the active account+folder, so it's disabled in
    // the unified view where rows span accounts/folders.
    onBatchMarkRead: unifiedInbox ? undefined : handleBatchMarkRead,
    onBatchStar: unifiedInbox ? undefined : handleBatchStar,
    onBatchMove: unifiedInbox ? undefined : handleBatchMove,
    // Conversation grouping for the active folder, only when the toggle is
    // on and not in the unified inbox (see loadFolder/the toggle effect).
    threads: conversationView && !unifiedInbox ? threadsByKey[`${accountId}:${currentFolder}`] : undefined,
  };

  const selectedRec = selectedMessage ? getRecord(accountId) : undefined;
  // Only expose source fetch for real IMAP messages that have a UID. POP3
  // messages and unloaded summaries (no UID yet) don't have source available.
  const onFetchSource =
    selectedMessage?.uid !== undefined && selectedRec && !isPop3(selectedRec)
      ? () =>
          fetchMessageSource(
            accountId,
            selectedRec.imap_host,
            selectedRec.imap_port,
            currentFolder,
            selectedMessage.uid!,
          )
      : undefined;

  const isMuted = mutedByAccount[accountId]?.has(selectedMessage?.messageId ?? "") ?? false;
  const isSpamFolder = normalizeFolderId(currentFolder) === "spam";

  const readerPaneProps = {
    accountId,
    accentColor,
    message: selectedMessage,
    folder: currentFolder,
    avatarIndex: store.findMessageIndex(accountId, currentFolder, selectedId),
    blockImages,
    allowedImageDomains,
    onAllowImageDomain: handleAllowImageDomain,
    isMuted,
    isSpamFolder,
    onToggleStar: handleToggleStar,
    onArchive: (id: number) => handleMoveMessage(id, "archive"),
    onMoveToSpam: (id: number) => handleMoveMessage(id, "spam"),
    onDelete: (id: number) => handleMoveMessage(id, "trash"),
    onMarkUnread: handleMarkUnread,
    onNotSpam: handleNotSpam,
    onSnooze: handleSnooze,
    onReply: handleReply,
    onReplyAll: handleReplyAll,
    onForward: handleForward,
    onDownloadAttachment: handleDownloadAttachment,
    onMuteThread: handleMuteThread,
    onFetchSource,
    onFetchInvite: isTauri() ? handleFetchInvite : undefined,
    onRespondToInvite: isTauri() ? handleRespondToInvite : undefined,
    readReceipts,
    onSendMdn: isTauri()
      ? (notifyAddress: string, originalMessageId: string, originalSubject: string) => {
          const rec = getRecord(accountId);
          if (!rec) return;
          const fromAddress = rec.display_name
            ? `${rec.display_name} <${accountId}>`
            : accountId;
          sendMdn({
            accountId,
            host: rec.smtp_host,
            port: rec.smtp_port,
            useStarttls: rec.smtp_use_starttls,
            notifyAddress,
            originalMessageId,
            originalSubject,
            recipientDisplayAddress: fromAddress,
          }).catch((e: unknown) => console.warn("MDN send failed:", e));
        }
      : undefined,
  };

  // Title + account colour + unread count for each tab. Unified-inbox tabs
  // get a fixed label; folder tabs show the folder's friendly name and the
  // account's local-part. The unread count is derived from what's loaded in
  // the store for that account's known folders (live, no backend call).
  const tabItems: TabItem[] = tabs.map((tab) => {
    if (tab.kind === "calendar") {
      return { id: tab.id, title: "Calendar", color: "#7C6AF7", unreadCount: 0 };
    }
    if (tab.kind === "add-account") {
      return { id: tab.id, title: "Add account", color: accentColor || "#00BCD4", unreadCount: 0 };
    }
    if (tab.kind === "contacts") {
      return { id: tab.id, title: "Address Book", color: "#4CC38A", unreadCount: 0 };
    }
    const folder = tab.selectedFolder[tab.accountId] ?? "INBOX";
    const accountShort = tab.accountId.split("@")[0] || tab.accountId;
    const title = tab.unified ? "Unified Inbox" : `${folderLabel(folder)} · ${accountShort}`;
    const color = resolveAccountColor(
      accountOverrides,
      tab.accountId,
      accounts.findIndex((a) => a.id === tab.accountId),
    );
    const tabFolders = foldersByAccount[tab.accountId] ?? ["INBOX"];
    const unreadCount = store.getAllMessages(tab.accountId, tabFolders).filter((m) => m.unread).length;
    return { id: tab.id, title, color: color || "#00BCD4", unreadCount };
  });

  return (
    <>
      <View style={styles.shell}>
        <View style={styles.glows} pointerEvents="none">
          <View style={[styles.glow, styles.glowCyan]} />
          <View style={[styles.glow, styles.glowPurple]} />
          <View style={[styles.glow, styles.glowGreen]} />
        </View>
        {/* The custom title bar always renders -- with native decorations
            off it's the only window chrome (drag region + min/max/close),
            so the welcome screen needs it too. Tabs and mail search only
            appear once onboarded, and search hides on calendar tabs. */}
        <TitleBar
          tabs={onboarded ? tabItems : []}
          activeTabId={activeTab.id}
          accentColor={accentColor || "#00BCD4"}
          onSelectTab={selectTab}
          onCloseTab={closeTab}
          onNewTab={onboarded ? openTab : undefined}
          filters={onboarded && activeTab.kind !== "calendar" ? filters : undefined}
          onFiltersChange={setFilters}
          filtersOpen={filtersOpen}
          onToggleFilters={setFiltersOpen}
          onRefresh={() => {
            store.applyRules(rules, accountId, currentFolder);
            loadFolder(accountId, currentFolder);
          }}
          focusSearchSignal={focusSearchSignal}
          showTabs={breakpoint !== "mobile"}
        />
        {locked && lockConfig ? (
          <LockScreen
            accentColor={accentColor || "#00BCD4"}
            config={lockConfig}
            onUnlock={() => setUnlocked(true)}
          />
        ) : !onboarded ? (
          addAccountOpen ? (
            <AddAccountView
              accentColor={accentColor || "#00BCD4"}
              onCancel={() => setAddAccountOpen(false)}
              onDone={handleAccountAdded}
            />
          ) : (
            <WelcomeScreen accentColor={accentColor || "#00BCD4"} onAddAccount={openAddAccount} />
          )
        ) : (
        <View style={styles.workspace}>
          <View style={styles.panels}>
          {activeTab.kind === "calendar" || activeTab.kind === "add-account" || activeTab.kind === "contacts" ? (
            <>
              {breakpoint === "desktop" && (
                <>
                  <Sidebar {...sidebarProps} width={sidebarWidth} />
                  <Splitter
                    accentColor={accentColor}
                    onDragStart={() => (sidebarDragStart.current = sidebarWidth)}
                    onDrag={handleSidebarDrag}
                  />
                </>
              )}
              {activeTab.kind === "calendar" && <CalendarView accentColor={accentColor} />}
              {activeTab.kind === "add-account" && (
                <AddAccountView
                  accentColor={accentColor || "#00BCD4"}
                  onCancel={() => closeTab(activeTab.id)}
                  onDone={handleAccountAdded}
                />
              )}
              {activeTab.kind === "contacts" && (
                <AddressBookView
                  accentColor={accentColor}
                  accounts={accounts}
                  selectedSource={selectedAddressBook}
                />
              )}
            </>
          ) : (
            <>
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
            </>
          )}

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
        </View>
        )}
      </View>
      <ComposeModal
        visible={composeOpen}
        accentColor={accentColor}
        accounts={accounts}
        accountOverrides={accountOverrides}
        fromAccountId={composeFromAccountId ?? accountId}
        onFromAccountChange={setComposeFromAccountId}
        identities={identitiesByAccount[composeFromAccountId ?? accountId] ?? []}
        signature={signature}
        encryptByDefault={encryptByDefault}
        prefill={composePrefill}
        templates={templates}
        onSaveTemplate={handleSaveTemplate}
        onSend={handleSend}
        onClose={handleComposeClose}
        draftContext={(() => {
          const draftAccountId = composeFromAccountId ?? accountId;
          const rec = getRecord(draftAccountId);
          if (!rec) return undefined;
          return {
            accountId: draftAccountId,
            imapHost: rec.imap_host,
            imapPort: rec.imap_port,
            draftsFolder: rec.drafts_folder,
          };
        })()}
      />
      {undoSendState && (
        <UndoSendToast
          outboxId={undoSendState.outboxId}
          windowSeconds={UNDO_SEND_WINDOW}
          onUndo={() => {
            cancelQueuedSend(undoSendState.outboxId).catch(console.warn);
            setUndoSendState(null);
          }}
          onDismiss={() => {
            const sendAccount = undoSendState.accountId;
            // Deliver, then reload the Sent folder so the message appears
            // there right away instead of waiting for a manual refresh.
            flushOutbox(sendAccount)
              .then(() => refreshSentFolder(sendAccount))
              .catch(console.warn);
            setUndoSendState(null);
          }}
        />
      )}
      <SettingsModal
        visible={settingsOpen}
        accountId={accountId}
        accounts={accounts}
        accentColor={accentColor}
        accountOverrides={accountOverrides}
        onUpdateAccountOverride={handleUpdateAccountOverride}
        values={{
          compactList,
          unifiedInbox,
          conversationView,
          separateUnread,
          blockImages,
          readReceipts,
          encryptByDefault,
          signature,
          syncDepth,
          fontScale,
        }}
        onApply={(v) => {
          setCompactList(v.compactList);
          setUnifiedInbox(v.unifiedInbox);
          setConversationView(v.conversationView);
          setSeparateUnread(v.separateUnread);
          setBlockImages(v.blockImages);
          setReadReceipts(v.readReceipts);
          setEncryptByDefault(v.encryptByDefault);
          setSignature(v.signature);
          setSyncDepth(v.syncDepth);
          setFontScale(v.fontScale);
        }}
        onAddAccount={openAddAccount}
        templates={templates}
        onDeleteTemplate={handleDeleteTemplate}
        rules={rules}
        onSaveRule={handleSaveRule}
        onDeleteRule={handleDeleteRule}
        shortcutBindings={shortcutBindings}
        onRebindShortcut={handleRebindShortcut}
        onResetShortcuts={handleResetShortcuts}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

const glow: WebViewStyle = {
  position: "absolute",
  borderRadius: 9999,
  filter: "blur(130px)",
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
  // Top-left: cyan/teal — cool anchor
  glowCyan: {
    width: 560,
    height: 560,
    top: -200,
    left: -140,
    backgroundColor: withAlpha(colors.accent.cyan, 0.28),
  },
  // Top-right: purple — warm contrast
  glowPurple: {
    width: 500,
    height: 500,
    top: -160,
    right: -100,
    backgroundColor: withAlpha(colors.accent.purple, 0.22),
  },
  // Bottom-right: green — depth
  glowGreen: {
    width: 600,
    height: 600,
    bottom: -240,
    right: -80,
    backgroundColor: withAlpha(colors.accent.green, 0.18),
  },
  workspace: {
    flex: 1,
    height: "100%",
    flexDirection: "column",
  },
  panels: {
    flex: 1,
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
