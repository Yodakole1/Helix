import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import { folderLabel } from "../data/folders";
import { formatMessageTime } from "../data/messages";
import { useAnchorRect } from "../hooks/useAnchorRect";
import type { MessageWithFolder, ThreadMeta } from "../hooks/useMessageStore";
import type { HoverState } from "../lib/pressable";
import {
  filterMessages,
  sortMessages,
  SORT_OPTIONS,
  type MessageFilters,
  type SortKey,
} from "../lib/messageFilters";
import { glassPanel } from "../lib/webStyle";
import type { AccountId } from "../theme";
import { colorForKey, colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";
import { Tooltip } from "./Tooltip";

interface MessageListProps {
  accountId: AccountId;
  // Real accounts from useAccounts(), same list the sidebar uses.
  accounts: MailAccount[];
  accentColor: string;
  accountOverrides: AccountOverrides;
  folder: string;
  // True when Settings' "Unified inbox" is on -- `messages` is then every
  // account's Inbox merged (see App.tsx), and rows show which account
  // each message is from since it's no longer implied by what's open.
  unified: boolean;
  messages: MessageWithFolder[];
  // Every folder's messages for the account, only consulted while the
  // search box has text in it.
  allAccountMessages: MessageWithFolder[];
  selectedId: number;
  onSelect: (id: number, folder: string, accountId: AccountId) => void;
  onToggleStar: (id: number, accountId: AccountId, folder: string) => void;
  compact: boolean;
  width: number | "100%";
  // Search query + structured filters, owned by App and edited from the
  // title bar's search box / filter panel (they moved there with the
  // custom-title-bar redesign); this component only applies them.
  filters: MessageFilters;
  // Settings' "Separate unread from read": unread messages group into a
  // labelled section above the read ones.
  separateUnread?: boolean;
  // Marks every message in the current folder read (mark_folder_seen).
  onMarkAllRead?: () => void;
  // Runs a server-side IMAP search and local FTS for the typed query
  // (debounced). The client-side filter still does the live narrowing;
  // this just widens the pool it draws from. The optional structured
  // filters are forwarded to the local FTS layer (which supports them);
  // IMAP search always uses just the text query.
  onSearch?: (query: string, filters?: { fromFilter?: string; isUnread?: boolean | null; isFlagged?: boolean | null; hasAttachment?: boolean | null }) => void;
  // Batch (multi-select) actions, called with the selected message ids.
  onBatchMarkRead?: (ids: number[], read: boolean) => void;
  onBatchStar?: (ids: number[], starred: boolean) => void;
  onBatchMove?: (ids: number[], dest: "archive" | "trash") => void;
  // When set (conversation view on), messages are grouped into threads:
  // only roots show until expanded. Absent/undefined = flat list.
  threads?: ThreadMeta;
}

export function MessageList({
  accountId,
  accounts,
  accentColor,
  accountOverrides,
  folder,
  unified,
  messages: allMessages,
  allAccountMessages,
  selectedId,
  onSelect,
  onToggleStar,
  compact,
  width,
  filters,
  separateUnread = false,
  onMarkAllRead,
  onSearch,
  onBatchMarkRead,
  onBatchStar,
  onBatchMove,
  threads,
}: MessageListProps) {
  const currentFolderLabel = unified ? "Unified Inbox" : folderLabel(folder);
  const unreadCount = allMessages.filter((message) => message.unread).length;
  const hasUnread = unreadCount > 0;

  // Which thread roots are expanded. Collapsed by default -- a folder opens
  // showing one row per conversation, expandable on demand.
  const [expandedThreads, setExpandedThreads] = useState<Set<number>>(new Set());
  function toggleThread(rootId: number) {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }

  // Multi-select: ids of checked rows. Cleared when the folder/account
  // changes (below) so a selection never carries into an unrelated list.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const batchEnabled = Boolean(onBatchMarkRead || onBatchStar || onBatchMove);

  function toggleSelected(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function runBatch(action: () => void) {
    action();
    clearSelection();
  }

  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortAnchorRef, sortAnchorRect] = useAnchorRect(sortMenuOpen);

  // Selection/thread expansion never carry into an unrelated list. (The
  // search/filter reset on folder change lives in App now, alongside the
  // filters themselves.)
  useEffect(() => {
    setSortMenuOpen(false);
    setSelectedIds(new Set());
    setExpandedThreads(new Set());
  }, [accountId, folder]);

  // Debounced server-side search: fire ~400ms after typing stops, for
  // queries of at least 2 characters, so every keystroke doesn't open an
  // IMAP connection. The client-side filter below reacts instantly; this
  // only backfills the pool with server matches. Structured filters are
  // forwarded to the local FTS layer (they're not sent to IMAP).
  useEffect(() => {
    const query = filters.query.trim();
    if (!onSearch || query.length < 2) return;
    const timer = setTimeout(() => onSearch(query, {
      fromFilter: filters.from.trim() || undefined,
      isUnread: filters.isUnread,
      isFlagged: filters.isFlagged,
      hasAttachment: filters.hasAttachment,
    }), 400);
    return () => clearTimeout(timer);
  }, [filters.query, filters.from, filters.isUnread, filters.isFlagged, filters.hasAttachment]);

  // Typing in the search box broadens scope to every folder in the
  // account; leaving it empty and only using the From/To/Date filter
  // panel keeps the existing folder-scoped behavior.
  const searchActive = filters.query.trim() !== "";
  const pool = searchActive ? allAccountMessages : allMessages;

  // Conversation view: group into threads, showing only roots until
  // expanded. Bypassed while searching (a search wants flat matches) and in
  // the unified inbox (rows there span accounts, which the per-folder thread
  // grouping doesn't model).
  const threaded = Boolean(threads) && !unified && !searchActive;
  function buildThreadedList(meta: ThreadMeta): MessageWithFolder[] {
    const byId = new Map(allMessages.map((message) => [message.id, message]));
    const roots = meta.rootIds
      .map((id) => byId.get(id))
      .filter((message): message is MessageWithFolder => Boolean(message));
    const sortedRoots = sortMessages(filterMessages(roots, filters), sortKey);
    const out: MessageWithFolder[] = [];
    for (const root of sortedRoots) {
      const count = meta.countByRoot[root.id] ?? 1;
      const expanded = expandedThreads.has(root.id);
      out.push({ ...root, threadRoot: true, threadReplyCount: count - 1, threadExpanded: expanded, threadDepth: 0 });
      if (expanded) {
        for (const childId of meta.childrenByRoot[root.id] ?? []) {
          const child = byId.get(childId);
          if (child) out.push({ ...child, threadDepth: meta.depthById[childId] ?? 1 });
        }
      }
    }
    return out;
  }

  const sortedMessages =
    threaded && threads ? buildThreadedList(threads) : sortMessages(filterMessages(pool, filters), sortKey);
  // "Separate unread from read": unread first (each half keeps the sort
  // order), with section labels rendered when both halves exist. Skipped in
  // conversation view, where a thread mixes read and unread messages.
  const sectioned = separateUnread && !threaded;
  const visibleMessages = sectioned
    ? [...sortedMessages.filter((m) => m.unread), ...sortedMessages.filter((m) => !m.unread)]
    : sortedMessages;
  const showSectionLabels =
    sectioned && visibleMessages.some((m) => m.unread) && visibleMessages.some((m) => !m.unread);
  const currentSortLabel = SORT_OPTIONS.find((option) => option.key === sortKey)?.label ?? "";

  function renderItem({ item, index }: { item: MessageWithFolder; index: number }) {
    // The id alone isn't unique in the unified inbox -- IMAP UIDs are
    // per-folder, so two accounts (or two folders in search results) can
    // both hold a message with the same uid.
    const selected = item.id === selectedId && item.accountId === accountId && item.folder === folder;
    const checked = selectedIds.has(item.id);
    const avatarColor = colorForKey(item.senderEmail || item.sender);
    const attachment = item.realAttachments?.[0];
    const extraAttachments = (item.realAttachments?.length ?? 0) - 1;
    const otherFolderLabel = searchActive && item.folder !== folder ? folderLabel(item.folder) : undefined;
    const accountIndex = unified ? accounts.findIndex((candidate) => candidate.id === item.accountId) : -1;
    const accountInfo = accountIndex === -1 ? undefined : accounts[accountIndex];
    const accountColor = accountInfo ? resolveAccountColor(accountOverrides, accountInfo.id, accountIndex) : undefined;
    // Section label above the first row of each unread/read group.
    const sectionLabel =
      showSectionLabels && (index === 0 || visibleMessages[index - 1].unread !== item.unread)
        ? item.unread
          ? "Unread"
          : "Read"
        : null;
    return (
      <>
        {/* Outside rowWrapper: its absolutely-positioned children (star,
            checkbox) measure against the row itself, not the label. */}
        {sectionLabel && (
          <Text style={[styles.sectionLabel, sectionLabel === "Unread" && { color: accentColor }]}>
            {sectionLabel}
          </Text>
        )}
      <View style={styles.rowWrapper}>
        {batchEnabled && (
          // Sibling of the row's Pressable (not a child) so toggling the
          // checkbox never also triggers the row's open handler -- same
          // reason the star button below is a sibling.
          <Pressable onPress={() => toggleSelected(item.id)} style={styles.checkboxButton}>
            <View
              style={[
                styles.checkbox,
                checked && { backgroundColor: accentColor, borderColor: accentColor },
              ]}
            >
              {checked && <ListIcon name="check" color={colors.background.base} size={11} />}
            </View>
          </Pressable>
        )}
        <Pressable
          onPress={() => onSelect(item.id, item.folder, item.accountId)}
          style={({ hovered }: HoverState) => [
            styles.row,
            compact && styles.rowCompact,
            batchEnabled && styles.rowCheckable,
            item.threadDepth ? { marginLeft: item.threadDepth * 16 } : null,
            selected && { backgroundColor: colors.background.panel, borderLeftColor: accentColor },
            checked && { backgroundColor: colors.background.surface },
            !selected && !checked && hovered && { backgroundColor: colors.background.panel },
          ]}
        >
          <View style={[styles.avatar, compact && styles.avatarCompact, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{(item.sender || "?").charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.rowContent}>
            <View style={styles.rowTop}>
              <View style={styles.senderGroup}>
                {item.unread && <View style={[styles.unreadDot, { backgroundColor: accentColor }]} />}
                <Text numberOfLines={1} style={[styles.sender, item.unread && styles.senderUnread]}>{item.sender}</Text>
                {accountInfo && (
                  <View style={[styles.folderBadge, { borderColor: accountColor }]}>
                    <Text style={[styles.folderBadgeText, { color: accountColor }]}>
                      {resolveAccountLabel(accountOverrides, accountInfo)}
                    </Text>
                  </View>
                )}
                {otherFolderLabel && (
                  <View style={styles.folderBadge}>
                    <Text style={styles.folderBadgeText}>{otherFolderLabel}</Text>
                  </View>
                )}
              </View>
              <Text style={styles.time}>{formatMessageTime(item.date)}</Text>
            </View>
            <Text numberOfLines={1} style={[styles.subject, item.unread && styles.subjectUnread]}>{item.subject}</Text>
            {attachment && (
              <View style={styles.attachmentRow}>
                <ListIcon name="attachment" color={colors.text.muted} size={11} />
                <Text style={styles.attachmentName} numberOfLines={1}>
                  {attachment.name}
                  {extraAttachments > 0 ? `  +${extraAttachments}` : ""}
                </Text>
              </View>
            )}
            {!compact && (
              <Text style={styles.preview} numberOfLines={1}>
                {item.preview}
              </Text>
            )}
          </View>
        </Pressable>
        {/* Sibling, not a child, of the row's own Pressable -- avoids
            needing to stop propagation on a nested press handler. */}
        <Pressable onPress={() => onToggleStar(item.id, item.accountId, item.folder)} style={styles.starButton}>
          <ListIcon name="star" filled={item.starred} color={item.starred ? colors.accent.amber : colors.text.muted} size={14} />
        </Pressable>
        {item.threadRoot && (item.threadReplyCount ?? 0) > 0 && (
          // Thread expand/collapse -- a sibling for the same propagation
          // reason as the star button. Tapping it toggles the conversation;
          // tapping the row still opens the root message.
          <Pressable onPress={() => toggleThread(item.id)} style={styles.threadToggle}>
            <Text style={styles.threadCount}>{item.threadReplyCount}</Text>
            <ListIcon name={item.threadExpanded ? "chevron-up" : "chevron-down"} color={colors.text.muted} size={10} />
          </Pressable>
        )}
      </View>
      </>
    );
  }

  return (
    <View style={[styles.pane, { width }]}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.titleGroup}>
            <Text style={styles.title}>{currentFolderLabel}</Text>
            {unreadCount > 0 && (
              <Text style={[styles.titleCount, { color: accentColor }]}>{unreadCount}</Text>
            )}
          </View>
          <View style={styles.headerTopActions}>
            {!unified && hasUnread && onMarkAllRead && (
              <Tooltip label="Mark all as read">
                <Pressable
                  onPress={onMarkAllRead}
                  style={({ hovered }: HoverState) => [
                    styles.refreshButton,
                    hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
                  ]}
                >
                  <ListIcon name="check" color={colors.text.secondary} size={14} />
                </Pressable>
              </Tooltip>
            )}

            <View style={styles.sortWrapper}>
              <Pressable
                ref={sortAnchorRef}
                onPress={() => setSortMenuOpen((value) => !value)}
                style={styles.sortButton}
              >
                <ListIcon name="sort" color={colors.text.secondary} size={12} />
                <Text style={styles.sortButtonText}>{currentSortLabel}</Text>
                <ListIcon name="chevron-down" color={colors.text.muted} size={10} />
              </Pressable>
              {/* Portaled (see FloatingPortal) rather than a plain absolute
                  child -- every react-native-web View is its own CSS
                  stacking context (implicit zIndex:0), so a local zIndex
                  can never out-rank unrelated elements higher in the tree. */}
              {sortMenuOpen && sortAnchorRect && (
                <FloatingPortal
                  top={sortAnchorRect.bottom + 4}
                  right={window.innerWidth - sortAnchorRect.right}
                  onDismiss={() => setSortMenuOpen(false)}
                >
                  <View style={styles.sortMenu}>
                    {SORT_OPTIONS.map((option) => {
                      const active = option.key === sortKey;
                      return (
                        <Pressable
                          key={option.key}
                          onPress={() => {
                            setSortKey(option.key);
                            setSortMenuOpen(false);
                          }}
                          style={({ hovered }: HoverState) => [
                            styles.sortMenuItem,
                            active && { backgroundColor: colors.background.surface },
                            !active && hovered && { backgroundColor: colors.background.surface },
                          ]}
                        >
                          <Text style={[styles.sortMenuItemText, active && { color: accentColor }]}>
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </FloatingPortal>
              )}
            </View>
          </View>
        </View>

      </View>

      {batchEnabled && selectedIds.size > 0 && (
        <View style={[styles.selectionBar, { borderColor: accentColor }]}>
          <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
          <View style={styles.selectionActions}>
            {onBatchMarkRead && (
              <>
                <Pressable onPress={() => runBatch(() => onBatchMarkRead([...selectedIds], true))} style={styles.selectionAction}>
                  <Text style={styles.selectionActionText}>Read</Text>
                </Pressable>
                <Pressable onPress={() => runBatch(() => onBatchMarkRead([...selectedIds], false))} style={styles.selectionAction}>
                  <Text style={styles.selectionActionText}>Unread</Text>
                </Pressable>
              </>
            )}
            {onBatchStar && (
              <Pressable onPress={() => runBatch(() => onBatchStar([...selectedIds], true))} style={styles.selectionAction}>
                <Text style={styles.selectionActionText}>Star</Text>
              </Pressable>
            )}
            {onBatchMove && (
              <>
                <Pressable onPress={() => runBatch(() => onBatchMove([...selectedIds], "archive"))} style={styles.selectionAction}>
                  <Text style={styles.selectionActionText}>Archive</Text>
                </Pressable>
                <Pressable onPress={() => runBatch(() => onBatchMove([...selectedIds], "trash"))} style={styles.selectionAction}>
                  <Text style={[styles.selectionActionText, { color: colors.accent.amber }]}>Trash</Text>
                </Pressable>
              </>
            )}
            <Pressable onPress={clearSelection} style={styles.selectionAction}>
              <Text style={styles.selectionActionText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        data={visibleMessages}
        extraData={selectedIds}
        // The account and folder are part of the key for the same reason
        // the selected-row check compares them: a bare uid collides across
        // accounts in the unified inbox and across folders in search hits.
        keyExtractor={(item) => `${item.accountId}:${item.folder}:${item.id}`}
        renderItem={renderItem}
        style={styles.list}
        // No scrollbar: it painted exactly over each row's star button, so
        // hovering the star hit the bar instead. Wheel/touch/keyboard
        // scrolling all still work; the bar was the only casualty.
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgba(255,255,255,0.1)", marginBottom: 8 }}>
              {allMessages.length === 0
                ? <><rect x="2" y="5" width="20" height="14" rx="2" /><polyline points="2 5 12 13 22 5" /></>
                : <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>}
            </svg>
            <Text style={styles.emptyStateText}>
              {allMessages.length === 0 ? "No messages in this folder" : "No messages match your search"}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const paneGlass = glassPanel(colors.background.surface, 0.4, 24);

const styles = StyleSheet.create({
  pane: {
    height: "100%",
    ...paneGlass,
    borderRightWidth: 1,
    borderRightColor: colors.border.strong,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  // Unread total beside the folder name -- mono because it's a count, in
  // the account accent so it reads as live status rather than a label.
  titleCount: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
  headerTopActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  // Shared square icon-button look (mark-all-read).
  refreshButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  sortWrapper: {
    position: "relative",
  },
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  sortButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginHorizontal: spacing.xs,
  },
  sortMenu: {
    marginTop: 4,
    minWidth: 140,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
  },
  sortMenuItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  sortMenuItemText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  list: {
    flex: 1,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  emptyStateText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    textAlign: "center",
  },
  rowWrapper: {
    position: "relative",
  },
  // "Unread"/"Read" group labels for the separate-unread setting.
  sectionLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    color: colors.text.muted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
  },
  rowCheckable: {
    paddingLeft: 38,
  },
  checkboxButton: {
    position: "absolute",
    left: spacing.sm,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    zIndex: 1,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  selectionCount: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.primary,
  },
  selectionActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  selectionAction: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  selectionActionText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  rowCompact: {
    paddingVertical: spacing.xs,
  },
  starButton: {
    position: "absolute",
    top: spacing.md,
    right: spacing.xs,
    padding: 4,
  },
  threadToggle: {
    position: "absolute",
    bottom: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  threadCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.secondary,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  avatarCompact: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginRight: spacing.sm,
  },
  avatarText: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  rowContent: {
    flex: 1,
    paddingRight: 20,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  // flex:1 + minWidth:0 so a long sender name truncates instead of pushing
  // the date off the row edge -- the date always stays pinned right.
  senderGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    marginRight: spacing.sm,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: spacing.xs,
  },
  sender: {
    flexShrink: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  senderUnread: {
    fontWeight: "600",
    color: colors.text.primary,
  },
  folderBadge: {
    marginLeft: spacing.xs,
    paddingVertical: 1,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  folderBadgeText: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    color: colors.text.muted,
  },
  time: {
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  subject: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  subjectUnread: {
    fontWeight: "600",
    color: colors.text.primary,
  },
  preview: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  attachmentRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 2,
  },
  attachmentName: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
    marginLeft: spacing.xs,
  },
});
