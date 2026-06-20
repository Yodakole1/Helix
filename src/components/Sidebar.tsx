import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ACCOUNTS } from "../data/accounts";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { Logo } from "./Logo";

interface FolderItem {
  id: string;
  label: string;
  glyph: string;
}

const FOLDERS: FolderItem[] = [
  { id: "inbox", label: "Inbox", glyph: "IN" },
  { id: "drafts", label: "Drafts", glyph: "DR" },
  { id: "sent", label: "Sent", glyph: "SE" },
  { id: "spam", label: "Spam", glyph: "SP" },
  { id: "archive", label: "Archive", glyph: "AR" },
  { id: "trash", label: "Trash", glyph: "TR" },
];


interface SidebarProps {
  accent: Accent;
  onAccentChange: (accent: Accent) => void;
  onAddAccount: () => void;
  onCompose: () => void;
  onOpenSettings: () => void;
}

// Switching the active account shifts the accent color used across the
// whole shell, not just here -- see the `accent` prop threaded through
// App.tsx.
export function Sidebar({ accent, onAccentChange, onAddAccount, onCompose, onOpenSettings }: SidebarProps) {
  const accentColor = colors.accent[accent];
  const [expanded, setExpanded] = useState<Record<Accent, boolean>>({ cyan: true, purple: true });
  const [selectedFolder, setSelectedFolder] = useState<Record<Accent, string>>({
    cyan: "inbox",
    purple: "inbox",
  });

  return (
    <View style={styles.sidebar}>
      <View style={styles.brand}>
        <View style={[styles.mark, { borderColor: accentColor, shadowColor: accentColor }]}>
          <Logo size={18} color={accentColor} />
        </View>
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

              {isExpanded && (
                <View style={styles.folderList}>
                  {FOLDERS.map((folder, index) => {
                    const folderActive = active && selectedFolder[account.id] === folder.id;
                    const folderColor = colorForIndex(index);
                    return (
                      <Pressable
                        key={folder.id}
                        onPress={() => {
                          onAccentChange(account.id);
                          setSelectedFolder((prev) => ({ ...prev, [account.id]: folder.id }));
                        }}
                        style={({ hovered }: HoverState) => [
                          styles.folder,
                          folderActive && { backgroundColor: colors.background.surface, borderColor: folderColor },
                          !folderActive && hovered && { backgroundColor: colors.background.surface },
                        ]}
                      >
                        <View style={[styles.folderIcon, { backgroundColor: withAlpha(folderColor, 0.18) }]}>
                          <Text style={[styles.folderGlyph, { color: folderColor }]}>{folder.glyph}</Text>
                        </View>
                        <Text style={[styles.folderLabel, folderActive && { color: colors.text.primary }]}>
                          {folder.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Pressable
        onPress={onAddAccount}
        style={({ hovered }: HoverState) => [styles.settings, hovered && { backgroundColor: colors.background.surface }]}
      >
        <View style={[styles.folderIcon, { backgroundColor: colors.background.surface }]}>
          <Text style={[styles.folderGlyph, { color: colors.text.muted }]}>+</Text>
        </View>
        <Text style={styles.folderLabel}>Add account</Text>
      </Pressable>

      <Pressable
        onPress={onOpenSettings}
        style={({ hovered }: HoverState) => [styles.settings, hovered && { backgroundColor: colors.background.surface }]}
      >
        <View style={[styles.folderIcon, { backgroundColor: colors.background.surface }]}>
          <Text style={[styles.folderGlyph, { color: colors.text.muted }]}>ST</Text>
        </View>
        <Text style={styles.folderLabel}>Settings</Text>
      </Pressable>
    </View>
  );
}

const sidebarGlass = glassPanel(colors.background.panel, 0.42, 24);

const styles = StyleSheet.create({
  sidebar: {
    width: 240,
    height: "100%",
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    ...sidebarGlass,
    borderRightWidth: 1,
    borderRightColor: colors.border.strong,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.lg,
  },
  mark: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.background.surface,
    marginRight: spacing.sm,
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
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
    fontSize: 10,
    color: colors.text.muted,
  },
  chevron: {
    fontSize: fontSize.md,
    color: colors.text.muted,
    transform: [{ rotate: "0deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  folderList: {
    marginTop: 2,
    marginBottom: spacing.sm,
    paddingLeft: spacing.lg,
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
  folderGlyph: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    fontWeight: "600",
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
