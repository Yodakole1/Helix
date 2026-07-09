import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAnchorRect } from "../hooks/useAnchorRect";
import {
  DATE_RANGE_OPTIONS,
  DEFAULT_FILTERS,
  hasActiveFilters,
  MONTH_OPTIONS,
  yearOptions,
  type MessageFilters,
} from "../lib/messageFilters";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, isLightTheme, radii, spacing, withAlpha } from "../theme";
import { Dropdown } from "./Dropdown";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";
import { Tooltip } from "./Tooltip";

const YEAR_OPTIONS = yearOptions();

// One tab's display data, same shape the old TabBar used. `color` is the
// account's rotating-palette color; `unreadCount` drives the badge.
export interface TabItem {
  id: string;
  title: string;
  color: string;
  unreadCount?: number;
}

interface TitleBarProps {
  // Tab strip. Empty + no onNew = tab strip hidden (welcome screen).
  tabs: TabItem[];
  activeTabId: string;
  accentColor: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab?: () => void;
  // Mail search + filters, hosted here (not in the message list) so the
  // title bar carries the app-wide chrome the way a browser does. Absent
  // (undefined) when no mailbox is active (welcome screen, calendar tab).
  filters?: MessageFilters;
  onFiltersChange?: (filters: MessageFilters) => void;
  filtersOpen?: boolean;
  onToggleFilters?: (open: boolean) => void;
  onRefresh?: () => void;
  // Incremented by the focus-search keyboard shortcut.
  focusSearchSignal?: number;
  // Hide the tab strip entirely (mobile breakpoint).
  showTabs?: boolean;
}

// Custom window title bar: Helix draws its own window controls (the native
// decorations are turned off in tauri.conf.json) so the tab strip, mailbox
// search, filters, and refresh all live on the one bar at the top instead
// of stacking a native title bar, a tab bar, and a per-pane toolbar. The
// empty area is a Tauri drag region -- grab it to move the window,
// double-click it to maximize, exactly like a browser's tab strip.
export function TitleBar({
  tabs,
  activeTabId,
  accentColor,
  onSelectTab,
  onCloseTab,
  onNewTab,
  filters,
  onFiltersChange,
  filtersOpen = false,
  onToggleFilters,
  onRefresh,
  focusSearchSignal,
  showTabs = true,
}: TitleBarProps) {
  const searchInputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (focusSearchSignal) searchInputRef.current?.focus();
  }, [focusSearchSignal]);

  const [filterAnchorRef, filterAnchorRect] = useAnchorRect(filtersOpen);

  const searchable = Boolean(filters && onFiltersChange);
  const activeFilters = filters ? hasActiveFilters(filters) : false;

  function patchFilters(patch: Partial<MessageFilters>) {
    if (filters && onFiltersChange) onFiltersChange({ ...filters, ...patch });
  }

  function windowAction(action: "minimize" | "toggleMaximize" | "close") {
    const win = getCurrentWindow();
    win[action]().catch((e) => console.warn(`window ${action} failed:`, e));
  }

  return (
    <View style={styles.bar}>
      {showTabs && (
        <View style={styles.tabStrip}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <Pressable
                key={tab.id}
                onPress={() => onSelectTab(tab.id)}
                style={({ hovered }: HoverState) => [
                  styles.tab,
                  active && { backgroundColor: withAlpha(accentColor, 0.16), borderColor: withAlpha(accentColor, 0.5) },
                  !active && hovered && styles.tabHover,
                ]}
              >
                <View style={[styles.dot, { backgroundColor: tab.color }]} />
                <Text
                  numberOfLines={1}
                  style={[styles.tabTitle, active ? { color: colors.text.primary } : { color: colors.text.muted }]}
                >
                  {tab.title}
                </Text>
                {!!tab.unreadCount && tab.unreadCount > 0 && (
                  <View style={[styles.badge, { backgroundColor: tab.color }]}>
                    <Text style={styles.badgeText}>{tab.unreadCount > 99 ? "99+" : String(tab.unreadCount)}</Text>
                  </View>
                )}
                {tabs.length > 1 && (
                  <Pressable
                    onPress={(event) => {
                      // Don't let the close click also select the tab underneath.
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    style={({ hovered }: HoverState) => [styles.close, hovered && styles.closeHover]}
                  >
                    <Text style={styles.closeText}>&#215;</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })}
          {onNewTab && (
            <Pressable
              onPress={onNewTab}
              style={({ hovered }: HoverState) => [styles.newTab, hovered && styles.tabHover]}
            >
              <Text style={[styles.newTabText, { color: accentColor }]}>+</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Raw div, not a View: data-tauri-drag-region only works on the
          element itself, and the empty stretch between tabs and search is
          the natural "grab the window here" area. */}
      <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch", minWidth: 24 }} />

      {searchable && (
        <View style={styles.searchGroup}>
          <View style={styles.searchInputWrapper}>
            <ListIcon name="search" color={colors.text.muted} size={15} />
            <TextInput
              ref={searchInputRef}
              style={styles.searchInput}
              value={filters!.query}
              onChangeText={(text) => patchFilters({ query: text })}
              placeholder="Search mail"
              placeholderTextColor={colors.text.muted}
            />
            {filters!.query.length > 0 && (
              <Pressable onPress={() => patchFilters({ query: "" })}>
                <ListIcon name="close" color={colors.text.muted} size={11} />
              </Pressable>
            )}
          </View>

          <Pressable
            ref={filterAnchorRef}
            onPress={() => onToggleFilters?.(!filtersOpen)}
            style={[styles.iconButton, (filtersOpen || activeFilters) && { borderColor: accentColor }]}
          >
            <ListIcon name="filter" color={filtersOpen || activeFilters ? accentColor : colors.text.muted} size={13} />
          </Pressable>

          {onRefresh && (
            <Tooltip label="Refresh">
              <Pressable
                onPress={onRefresh}
                style={({ hovered }: HoverState) => [
                  styles.iconButton,
                  hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
                ]}
              >
                <ListIcon name="refresh" color={colors.text.secondary} size={14} />
              </Pressable>
            </Tooltip>
          )}

          {filtersOpen && filterAnchorRect && filters && (
            <FloatingPortal
              top={filterAnchorRect.bottom + 6}
              right={window.innerWidth - filterAnchorRect.right}
              onDismiss={() => onToggleFilters?.(false)}
            >
              <View style={styles.filterPanel}>
                <View style={styles.filterPanelHeader}>
                  <Text style={styles.filterPanelTitle}>Filters</Text>
                  <Pressable onPress={() => onToggleFilters?.(false)}>
                    <ListIcon name="close" color={colors.text.muted} size={13} />
                  </Pressable>
                </View>
                <View style={styles.filterField}>
                  <Text style={styles.filterLabel}>From</Text>
                  <TextInput
                    style={styles.filterInput}
                    value={filters.from}
                    onChangeText={(text) => patchFilters({ from: text })}
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
                    onChangeText={(text) => patchFilters({ to: text })}
                    placeholder="Name or email"
                    placeholderTextColor={colors.text.muted}
                    autoCapitalize="none"
                  />
                </View>
                <View style={styles.filterField}>
                  <Text style={styles.filterLabel}>Date</Text>
                  <View style={styles.pillRow}>
                    {DATE_RANGE_OPTIONS.map((option) => {
                      const active = filters.dateRange === option.key;
                      return (
                        <Pressable
                          key={option.key}
                          onPress={() => patchFilters({ dateRange: option.key })}
                          style={[styles.pill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                        >
                          <Text style={[styles.pillText, active && { color: colors.background.base }]}>
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
                              patchFilters({ customFrom: `${filters.customFrom.split("-")[0]}-${month}` })
                            }
                          />
                        </View>
                        <Dropdown
                          value={filters.customFrom.split("-")[0]}
                          options={YEAR_OPTIONS}
                          accentColor={accentColor}
                          width={70}
                          onChange={(year) =>
                            patchFilters({ customFrom: `${year}-${filters.customFrom.split("-")[1]}` })
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
                              patchFilters({ customTo: `${filters.customTo.split("-")[0]}-${month}` })
                            }
                          />
                        </View>
                        <Dropdown
                          value={filters.customTo.split("-")[0]}
                          options={YEAR_OPTIONS}
                          accentColor={accentColor}
                          width={70}
                          onChange={(year) =>
                            patchFilters({ customTo: `${year}-${filters.customTo.split("-")[1]}` })
                          }
                        />
                      </View>
                    </View>
                  )}
                </View>
                <View style={styles.filterField}>
                  <Text style={styles.filterLabel}>Show</Text>
                  <View style={styles.pillRow}>
                    {(
                      [
                        { key: "isUnread", label: "Unread" },
                        { key: "isFlagged", label: "Starred" },
                        { key: "hasAttachment", label: "Attachment" },
                      ] as const
                    ).map(({ key, label }) => {
                      const active = filters[key] === true;
                      return (
                        <Pressable
                          key={key}
                          onPress={() => patchFilters({ [key]: filters[key] === true ? null : true })}
                          style={[styles.pill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                        >
                          <Text style={[styles.pillText, active && { color: colors.background.base }]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {activeFilters && (
                  <Pressable onPress={() => onFiltersChange?.(DEFAULT_FILTERS)}>
                    <Text style={[styles.clearFilters, { color: accentColor }]}>Clear filters</Text>
                  </Pressable>
                )}
              </View>
            </FloatingPortal>
          )}
        </View>
      )}

      {isTauri() && (
        <View style={styles.windowControls}>
          <Pressable
            onPress={() => windowAction("minimize")}
            style={({ hovered }: HoverState) => [styles.windowButton, hovered && styles.windowButtonHover]}
          >
            <svg width={12} height={12} viewBox="0 0 12 12" stroke={colors.text.secondary} strokeWidth={1.2}>
              <line x1="2" y1="6" x2="10" y2="6" />
            </svg>
          </Pressable>
          <Pressable
            onPress={() => windowAction("toggleMaximize")}
            style={({ hovered }: HoverState) => [styles.windowButton, hovered && styles.windowButtonHover]}
          >
            <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke={colors.text.secondary} strokeWidth={1.2}>
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            </svg>
          </Pressable>
          <Pressable
            onPress={() => windowAction("close")}
            style={({ hovered }: HoverState) => [styles.windowButton, hovered && styles.windowCloseHover]}
          >
            <svg width={12} height={12} viewBox="0 0 12 12" stroke={colors.text.secondary} strokeWidth={1.2}>
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    position: "relative",
    zIndex: 20,
    backgroundColor: isLightTheme ? "rgba(226,228,232,0.85)" : "rgba(10,10,15,0.72)",
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  // Browser-style shrink: the strip flexes but never pushes the search or
  // window controls off; each tab starts at its preferred width and every
  // tab shrinks equally down to a readable floor as more open.
  tabStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
    flexBasis: 200,
    minWidth: 54,
    maxWidth: 220,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: withAlpha(colors.text.primary, 0.04),
  },
  tabHover: {
    backgroundColor: withAlpha(colors.text.primary, 0.08),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  tabTitle: {
    flex: 1,
    minWidth: 0,
    fontFamily: fontFamily.ui,
    fontSize: 12.5,
    fontWeight: "600",
  },
  close: {
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  closeHover: {
    backgroundColor: withAlpha(colors.text.primary, 0.14),
  },
  closeText: {
    color: colors.text.muted,
    fontSize: 15,
    lineHeight: 17,
  },
  newTab: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    backgroundColor: withAlpha(colors.text.primary, 0.04),
  },
  newTabText: {
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 20,
  },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
    flexShrink: 0,
  },
  badgeText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    fontWeight: "700",
    color: colors.background.base,
  },
  searchGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexShrink: 0,
  },
  searchInputWrapper: {
    width: 320,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginLeft: spacing.xs,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  windowControls: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: spacing.xs,
    flexShrink: 0,
  },
  windowButton: {
    width: 34,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
  },
  windowButtonHover: {
    backgroundColor: withAlpha(colors.text.primary, 0.1),
  },
  windowCloseHover: {
    backgroundColor: "rgba(220, 60, 60, 0.85)",
  },
  filterPanel: {
    width: 320,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.md,
    backgroundColor: colors.background.panel,
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
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  pill: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  pillText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.text.secondary,
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
  clearFilters: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
