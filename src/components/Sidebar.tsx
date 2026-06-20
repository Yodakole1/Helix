import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ACCOUNTS } from "../data/accounts";
import { FOLDERS } from "../data/folders";
import { FolderIcon } from "./FolderIcon";
import type { HoverState } from "../lib/pressable";
import { glassPanel, type WebViewStyle } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface SidebarProps {
  accent: Accent;
  onAccentChange: (accent: Accent) => void;
  selectedFolder: Record<Accent, string>;
  onFolderChange: (account: Accent, folder: string) => void;
  onAddAccount: () => void;
  onCompose: () => void;
  onOpenSettings: () => void;
  width: number;
  // Tablet breakpoint renders the same tree as a dismissable drawer instead
  // of a fixed column -- see App.tsx's breakpoint branching.
  overlay?: boolean;
  onDismissOverlay?: () => void;
}

// Switching the active account shifts the accent color used across the
// whole shell, not just here -- see the `accent` prop threaded through
// App.tsx.
export function Sidebar({
  accent,
  onAccentChange,
  selectedFolder,
  onFolderChange,
  onAddAccount,
  onCompose,
  onOpenSettings,
  width,
  overlay = false,
  onDismissOverlay,
}: SidebarProps) {
  const accentColor = colors.accent[accent];
  const [expanded, setExpanded] = useState<Record<Accent, boolean>>({ cyan: true, purple: true });

  const content = (
    <View style={[styles.sidebar, { width }, overlay && styles.sidebarOverlay]}>
      <View style={styles.brand}>
        <Text style={styles.wordmark}>Helix</Text>
      </View>

      <Pressable
        onPress={onCompose}
        style={({ hovered }: HoverState) => [
          styles.compose,
          { backgroundColor: accentColor, shadowColor: accentColor },
          hovered && styles.composeHovered,
        ]}
      >
        <Text style={styles.composeText}>Compose</Text>
      </Pressable>

      <ScrollView style={styles.accounts}>
        {ACCOUNTS.map((account) => {
          const active = account.id === accent;
          const accountColor = colors.accent[account.id];
          const isExpanded = expanded[account.id];

          return (
            <View key={account.id}>
              <Pressable
                onPress={() => {
                  onAccentChange(account.id);
                  setExpanded((prev) => ({ ...prev, [account.id]: !prev[account.id] }));
                }}
                style={({ hovered }: HoverState) => [
                  styles.accountRow,
                  active && { backgroundColor: colors.background.surface, borderColor: accountColor },
                  !active && hovered && { backgroundColor: colors.background.surface },
                ]}
              >
                <View style={[styles.accountDot, { backgroundColor: accountColor }]} />
                <View style={styles.accountInfo}>
                  <Text style={[styles.accountLabel, active && { color: colors.text.primary }]}>
                    {account.label}
                  </Text>
                  <Text style={styles.accountEmail}>{account.email}</Text>
                </View>
                <Text
                  style={[
                    styles.chevron,
                    isExpanded && styles.chevronOpen,
                    active && { color: colors.text.secondary },
                  ]}
                >
                  &#8250;
                </Text>
              </Pressable>

              <View style={[styles.folderList, !isExpanded && styles.folderListCollapsed]}>
                {FOLDERS.map((folder, index) => {
                  const folderActive = active && selectedFolder[account.id] === folder.id;
                  const folderColor = colorForIndex(index);
                  return (
                    <Pressable
                      key={folder.id}
                      onPress={() => {
                        onFolderChange(account.id, folder.id);
                        onDismissOverlay?.();
                      }}
                      style={({ hovered }: HoverState) => [
                        styles.folder,
                        folderActive && { backgroundColor: colors.background.surface, borderColor: folderColor },
                        !folderActive && hovered && { backgroundColor: colors.background.surface },
                      ]}
                    >
                      <View style={[styles.folderIcon, { backgroundColor: withAlpha(folderColor, 0.18) }]}>
                        <FolderIcon id={folder.id} color={folderColor} />
                      </View>
                      <Text style={[styles.folderLabel, folderActive && { color: colors.text.primary }]}>
                        {folder.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <Pressable
        onPress={onAddAccount}
        style={({ hovered }: HoverState) => [styles.settings, hovered && { backgroundColor: colors.background.surface }]}
      >
        <View style={[styles.folderIcon, { backgroundColor: colors.background.surface }]}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.text.muted} strokeWidth={1.6} strokeLinecap="round">
            <circle cx={12} cy={12} r={9} />
            <line x1={12} y1={8} x2={12} y2={16} />
            <line x1={8} y1={12} x2={16} y2={12} />
          </svg>
        </View>
        <Text style={styles.folderLabel}>Add account</Text>
      </Pressable>

      <Pressable
        onPress={onOpenSettings}
        style={({ hovered }: HoverState) => [styles.settings, hovered && { backgroundColor: colors.background.surface }]}
      >
        <View style={[styles.folderIcon, { backgroundColor: colors.background.surface }]}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.text.muted} strokeWidth={1.6} strokeLinecap="round">
            <circle cx={12} cy={12} r={3} />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          </svg>
        </View>
        <Text style={styles.folderLabel}>Settings</Text>
      </Pressable>
    </View>
  );

  if (!overlay) {
    return content;
  }

  return (
    <View style={styles.overlayContainer}>
      <Pressable style={styles.overlayBackdrop} onPress={onDismissOverlay} />
      {content}
    </View>
  );
}

const sidebarGlass = glassPanel(colors.background.panel, 0.42, 24);
const chevronTransition: WebViewStyle = { transition: "transform 200ms ease" };
const folderListTransition: WebViewStyle = {
  transition: "max-height 200ms ease, opacity 150ms ease, margin-bottom 200ms ease",
};

const styles = StyleSheet.create({
  overlayContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    zIndex: 10,
  },
  overlayBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  sidebar: {
    height: "100%",
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    ...sidebarGlass,
    borderRightWidth: 1,
    borderRightColor: colors.border.strong,
  },
  sidebarOverlay: {
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 4, height: 0 },
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.lg,
  },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text.primary,
  },
  compose: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  composeHovered: {
    opacity: 0.9,
  },
  composeText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  accounts: {
    flex: 1,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
  },
  accountDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
  },
  accountInfo: {
    flex: 1,
  },
  accountLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  accountEmail: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  chevron: {
    fontSize: fontSize.md,
    color: colors.text.muted,
    transform: [{ rotate: "0deg" }],
    ...chevronTransition,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  folderList: {
    marginTop: 2,
    marginBottom: spacing.sm,
    paddingLeft: spacing.lg,
    maxHeight: 260,
    opacity: 1,
    overflow: "hidden",
    ...folderListTransition,
  },
  folderListCollapsed: {
    maxHeight: 0,
    opacity: 0,
    marginBottom: 0,
  },
  folder: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
    marginBottom: 2,
  },
  folderIcon: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  folderLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  settings: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
    marginTop: spacing.sm,
  },
});
