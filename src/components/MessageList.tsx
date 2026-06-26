import { useEffect, useRef, useState } from "react";
import { Animated, Easing, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import { folderLabel } from "../data/folders";
import { formatMessageTime, getAttachments } from "../data/messages";
import { useAnchorRect } from "../hooks/useAnchorRect";
import type { MessageWithFolder } from "../hooks/useMessageStore";
import type { HoverState } from "../lib/pressable";
import {
  DATE_RANGE_OPTIONS,
  DEFAULT_FILTERS,
  filterMessages,
  hasActiveFilters,
  MONTH_OPTIONS,
  sortMessages,
  SORT_OPTIONS,
  yearOptions,
  type MessageFilters,
  type SortKey,
} from "../lib/messageFilters";
import { glassPanel } from "../lib/webStyle";
import type { AccountId } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { Dropdown } from "./Dropdown";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";
import { Tooltip } from "./Tooltip";

const YEAR_OPTIONS = yearOptions();

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
  focusSearchSignal?: number;
  onApplyRules?: () => void;
  // Triggers a real fetch_messages call for the current folder.
  onRefresh?: () => void;
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
  focusSearchSignal,
  onApplyRules,
  onRefresh,
}: MessageListProps) {
  const currentFolderLabel = unified ? "Unified Inbox" : folderLabel(folder);

  const searchInputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (focusSearchSignal !== undefined) searchInputRef.current?.focus();
  }, [focusSearchSignal]);

  const [filters, setFilters] = useState<MessageFilters>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortAnchorRef, sortAnchorRect] = useAnchorRect(sortMenuOpen);
  const [refreshing, setRefreshing] = useState(false);
  const spinValue = useRef(new Animated.Value(0)).current;

  // A stale "from: x" filter silently emptying an unrelated folder you just
  // switched into would be confusing -- sort preference is fine to keep,
  // search/filters are not.
  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
    setFiltersOpen(false);
    setSortMenuOpen(false);
  }, [accountId, folder]);

  // There's no real fetch behind this yet (see backend-backlog.md --
  // fetch_messages/fetch_unified_inbox exist server-side but nothing in
  // the frontend calls them), so this just plays the loading state for a
  // beat rather than silently doing nothing when pressed.
  useEffect(() => {
    if (!refreshing) return;
    spinValue.setValue(0);
    const animation = Animated.loop(
      Animated.timing(spinValue, { toValue: 1, duration: 700, easing: Easing.linear, useNativeDriver: false }),
    );
    animation.start();
    const timeout = setTimeout(() => setRefreshing(false), 900);
    return () => {
      animation.stop();
      clearTimeout(timeout);
    };
  }, [refreshing]);

  const spin = spinValue.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  // Typing in the search box broadens scope to every folder in the
  // account; leaving it empty and only using the From/To/Date filter
  // panel keeps the existing folder-scoped behavior.
  const searchActive = filters.query.trim() !== "";
  const pool = searchActive ? allAccountMessages : allMessages;
  const visibleMessages = sortMessages(filterMessages(pool, filters), sortKey);
  const activeFilters = hasActiveFilters(filters);
  const currentSortLabel = SORT_OPTIONS.find((option) => option.key === sortKey)?.label ?? "";

  function renderItem({ item, index }: { item: MessageWithFolder; index: number }) {
    const selected = item.id === selectedId;
    const avatarColor = colorForIndex(index);
    // Row preview only ever shows the first attachment's name -- a
    // paperclip + "N attachments" count would be more accurate for a
    // multi-attachment message, but that's a bigger row-layout change than
    // this list view needs right now.
    const attachment = getAttachments(item.id)[0];
    const otherFolderLabel = searchActive && item.folder !== folder ? folderLabel(item.folder) : undefined;
    const accountIndex = unified ? accounts.findIndex((candidate) => candidate.id === item.accountId) : -1;
    const accountInfo = accountIndex === -1 ? undefined : accounts[accountIndex];
    const accountColor = accountInfo ? resolveAccountColor(accountOverrides, accountInfo.id, accountIndex) : undefined;
    return (
      <View style={styles.rowWrapper}>
        <Pressable
          onPress={() => onSelect(item.id, item.folder, item.accountId)}
          style={({ hovered }: HoverState) => [
            styles.row,
            compact && styles.rowCompact,
            selected && { backgroundColor: colors.background.panel, borderLeftColor: accentColor },
            !selected && hovered && { backgroundColor: colors.background.panel },
          ]}
        >
          <View style={[styles.avatar, compact && styles.avatarCompact, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{item.sender.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.rowContent}>
            <View style={styles.rowTop}>
              <View style={styles.senderGroup}>
                {item.unread && <View style={[styles.unreadDot, { backgroundColor: accentColor }]} />}
                <Text style={[styles.sender, item.unread && styles.senderUnread]}>{item.sender}</Text>
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
            <Text style={[styles.subject, item.unread && styles.subjectUnread]}>{item.subject}</Text>
            {attachment && (
              <View style={styles.attachmentRow}>
                <ListIcon name="attachment" color={colors.text.muted} size={11} />
                <Text style={styles.attachmentName} numberOfLines={1}>
                  {attachment.name}
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
      </View>
    );
  }

  return (
    <View style={[styles.pane, { width }]}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>{currentFolderLabel}</Text>
          <View style={styles.headerTopActions}>
            <Tooltip label="Refresh (also re-applies rules)">
              <Pressable
                onPress={() => {
                  if (refreshing) return;
                  setRefreshing(true);
                  onApplyRules?.();
                  onRefresh?.();
                }}
                disabled={refreshing}
                style={styles.refreshButton}
              >
                <Animated.View style={{ transform: [{ rotate: refreshing ? spin : "0deg" }] }}>
                  <ListIcon name="refresh" color={colors.text.secondary} size={13} />
                </Animated.View>
              </Pressable>
            </Tooltip>

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
                  child -- it otherwise has to out-rank searchRowWrapper,
                  a later sibling several levels up, and every
                  react-native-web View is its own CSS stacking context
                  (implicit zIndex:0) so a local zIndex can never win that
                  fight no matter how high it's set. */}
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

        <View style={styles.searchRowWrapper}>
          <View style={styles.searchRow}>
            <View style={styles.searchInputWrapper}>
              <ListIcon name="search" color={colors.text.muted} size={13} />
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                value={filters.query}
                onChangeText={(text) => setFilters((current) => ({ ...current, query: text }))}
                placeholder="Search mail"
                placeholderTextColor={colors.text.muted}
              />
              {filters.query.length > 0 && (
                <Pressable onPress={() => setFilters((current) => ({ ...current, query: "" }))}>
                  <ListIcon name="close" color={colors.text.muted} size={11} />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={() => setFiltersOpen((value) => !value)}
              style={[styles.filterToggle, (filtersOpen || activeFilters) && { borderColor: accentColor }]}
            >
              <ListIcon name="filter" color={filtersOpen || activeFilters ? accentColor : colors.text.muted} size={13} />
            </Pressable>
          </View>
        </View>

        {filtersOpen && (
        // Anchored to the header itself (zIndex above sortWrapper) rather
        // than to searchRowWrapper -- it pops up from the top of the pane
        // and overlaps the search bar it sits below, instead of dropping
        // down and hiding the first rows of the message list.
        <View style={styles.filterPanel}>
          <View style={styles.filterPanelHeader}>
            <Text style={styles.filterPanelTitle}>Filters</Text>
            {/* The toggle button that opened this is now buried underneath
                it, so this is the only reachable way to close it besides
                clicking outside via dismissOverlay. */}
            <Pressable onPress={() => setFiltersOpen(false)}>
              <ListIcon name="close" color={colors.text.muted} size={13} />
            </Pressable>
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>From</Text>
            <TextInput
              style={styles.filterInput}
              value={filters.from}
              onChangeText={(text) => setFilters((current) => ({ ...current, from: text }))}
              placeholder="Name or email"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>To</Text>
            <TextInput
              style={styles.filterInput}
              value={filters.to}
              onChangeText={(text) => setFilters((current) => ({ ...current, to: text }))}
              placeholder="Name or email"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>Date</Text>
            <View style={styles.dateRangeRow}>
              {DATE_RANGE_OPTIONS.map((option) => {
                const active = filters.dateRange === option.key;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setFilters((current) => ({ ...current, dateRange: option.key }))}
                    style={[styles.dateRangePill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                  >
                    <Text style={[styles.dateRangePillText, active && { color: colors.background.base }]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {filters.dateRange === "custom" && (
              <View style={styles.customDateRange}>
                <View style={styles.customDateField}>
                  <Text style={styles.customDateLabel}>From</Text>
                  <View style={styles.customDateDropdownGap}>
                    <Dropdown
                      value={filters.customFrom.split("-")[1]}
                      options={MONTH_OPTIONS}
                      accentColor={accentColor}
                      width={62}
                      onChange={(month) =>
                        setFilters((current) => ({ ...current, customFrom: `${current.customFrom.split("-")[0]}-${month}` }))
                      }
                    />
                  </View>
                  <Dropdown
                    value={filters.customFrom.split("-")[0]}
                    options={YEAR_OPTIONS}
                    accentColor={accentColor}
                    width={70}
                    onChange={(year) =>
                      setFilters((current) => ({ ...current, customFrom: `${year}-${current.customFrom.split("-")[1]}` }))
                    }
                  />
                </View>
                <View style={styles.customDateField}>
                  <Text style={styles.customDateLabel}>To</Text>
                  <View style={styles.customDateDropdownGap}>
                    <Dropdown
                      value={filters.customTo.split("-")[1]}
                      options={MONTH_OPTIONS}
                      accentColor={accentColor}
                      width={62}
                      onChange={(month) =>
                        setFilters((current) => ({ ...current, customTo: `${current.customTo.split("-")[0]}-${month}` }))
                      }
                    />
                  </View>
                  <Dropdown
                    value={filters.customTo.split("-")[0]}
                    options={YEAR_OPTIONS}
                    accentColor={accentColor}
                    width={70}
                    onChange={(year) =>
                      setFilters((current) => ({ ...current, customTo: `${year}-${current.customTo.split("-")[1]}` }))
                    }
                  />
                </View>
              </View>
            )}
          </View>
          {activeFilters && (
            <Pressable onPress={() => setFilters(DEFAULT_FILTERS)}>
              <Text style={[styles.clearFilters, { color: accentColor }]}>Clear filters</Text>
            </Pressable>
          )}
        </View>
        )}
      </View>

      {/* Only filtersOpen needs this -- the sort menu is portaled and
          dismisses itself via FloatingPortal's own full-viewport backdrop. */}
      {filtersOpen && <Pressable style={styles.dismissOverlay} onPress={() => setFiltersOpen(false)} />}

      <FlatList
        data={visibleMessages}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        style={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyState}>
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
    // Without this, the dismiss overlay (below) paints above this whole
    // block despite its own zIndex being lower -- header has no explicit
    // stacking context otherwise, so the filter panel's zIndex only
    // resolves against its own siblings inside header, not the overlay.
    zIndex: 15,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  headerTopActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  refreshButton: {
    width: 26,
    height: 26,
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
  dismissOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
  searchRowWrapper: {
    position: "relative",
    zIndex: 20,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  searchInputWrapper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginRight: spacing.xs,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    marginLeft: spacing.xs,
  },
  filterToggle: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  filterPanel: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.md,
    backgroundColor: colors.background.panel,
    // Above headerTop and searchRowWrapper, its only siblings inside
    // header, so it always wins the header's internal stacking order and
    // fully covers the search bar beneath it.
    zIndex: 30,
  },
  filterPanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  filterPanelTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  filterField: {
    marginBottom: spacing.sm,
  },
  filterLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: 4,
  },
  filterInput: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.primary,
  },
  dateRangeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dateRangePill: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  customDateRange: {
    marginTop: spacing.sm,
  },
  customDateField: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  customDateLabel: {
    width: 32,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  customDateDropdownGap: {
    marginRight: spacing.xs,
  },
  dateRangePillText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.text.secondary,
  },
  clearFilters: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
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
    fontSize: fontSize.xs,
    color: colors.text.muted,
    textAlign: "center",
  },
  rowWrapper: {
    position: "relative",
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
  rowCompact: {
    paddingVertical: spacing.xs,
  },
  starButton: {
    position: "absolute",
    top: spacing.md,
    right: spacing.xs,
    padding: 4,
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
  senderGroup: {
    flexDirection: "row",
    alignItems: "center",
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: spacing.xs,
  },
  sender: {
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
