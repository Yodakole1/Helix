import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import { folderLabel, normalizeFolderId } from "../data/folders";
import { FolderIcon } from "./FolderIcon";
import { FloatingPortal } from "./FloatingPortal";
import type { HoverState } from "../lib/pressable";
import { glassPanel, type WebViewStyle } from "../lib/webStyle";
import { accentCycle, colorForIndex, colors, fontFamily, fontSize, radii, spacing, withAlpha, type AccountId } from "../theme";

interface SidebarProps {
  accountId: AccountId;
  // Real accounts from useAccounts()/list_accounts(), not the old hardcoded
  // ACCOUNTS constant.
  accounts: MailAccount[];
  accentColor: string;
  accountOverrides: AccountOverrides;
  // Raw IMAP folder names per account, from list_folders(). Empty array
  // while folders are still loading for a given account.
  foldersByAccount: Record<AccountId, string[]>;
  onUpdateAccountOverride: (accountId: AccountId, patch: { label?: string; color?: string }) => void;
  onAccountChange: (accountId: AccountId) => void;
  selectedFolder: Record<AccountId, string>;
  onFolderChange: (accountId: AccountId, folder: string) => void;
  onCompose: () => void;
  onOpenSettings: () => void;
  width: number;
  // Tablet breakpoint renders the same tree as a dismissable drawer instead
  // of a fixed column -- see App.tsx's breakpoint branching.
  overlay?: boolean;
  onDismissOverlay?: () => void;
}

// Switching the active account shifts the accent color used across the
// whole shell, not just here -- see the `accentColor` prop threaded
// through App.tsx.
export function Sidebar({
  accountId,
  accounts,
  accentColor,
  accountOverrides,
  foldersByAccount,
  onUpdateAccountOverride,
  onAccountChange,
  selectedFolder,
  onFolderChange,
  onCompose,
  onOpenSettings,
  width,
  overlay = false,
  onDismissOverlay,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<AccountId, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ accountId: AccountId; top: number; left: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  function openContextMenu(event: React.MouseEvent, forAccountId: AccountId) {
    event.preventDefault();
    const account = accounts.find((a) => a.id === forAccountId);
    if (!account) return;
    setRenameDraft(resolveAccountLabel(accountOverrides, account));
    setContextMenu({ accountId: forAccountId, top: event.clientY, left: event.clientX });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function commitRename() {
    if (!contextMenu) return;
    const trimmed = renameDraft.trim();
    if (trimmed !== "") onUpdateAccountOverride(contextMenu.accountId, { label: trimmed });
    closeContextMenu();
  }

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
        {accounts.map((account, accountIndex) => {
          const active = account.id === accountId;
          const accountColor = resolveAccountColor(accountOverrides, account.id, accountIndex);
          const isExpanded = expanded[account.id] ?? true;
          // Use real folders from list_folders() when available.
          const folders = foldersByAccount[account.id] ?? [];

          return (
            <View key={account.id}>
              <div onContextMenu={(event) => openContextMenu(event, account.id)}>
                <Pressable
                  onPress={() => {
                    onAccountChange(account.id);
                    setExpanded((prev) => ({ ...prev, [account.id]: !isExpanded }));
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
                      {resolveAccountLabel(accountOverrides, account)}
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
              </div>

              <View style={[styles.folderList, !isExpanded && styles.folderListCollapsed]}>
                {folders.map((rawFolder, index) => {
                  const normalId = normalizeFolderId(rawFolder);
                  const folderActive = active && selectedFolder[account.id] === rawFolder;
                  const folderColor = colorForIndex(index);
                  return (
                    <Pressable
                      key={rawFolder}
                      onPress={() => {
                        onFolderChange(account.id, rawFolder);
                        onDismissOverlay?.();
                      }}
                      style={({ hovered }: HoverState) => [
                        styles.folder,
                        folderActive && { backgroundColor: colors.background.surface, borderColor: folderColor },
                        !folderActive && hovered && { backgroundColor: colors.background.surface },
                      ]}
                    >
                      <View style={[styles.folderIcon, { backgroundColor: withAlpha(folderColor, 0.18) }]}>
                        <FolderIcon id={normalId} color={folderColor} />
                      </View>
                      <Text style={[styles.folderLabel, folderActive && { color: colors.text.primary }]}>
                        {folderLabel(rawFolder)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {contextMenu && (
        <FloatingPortal top={contextMenu.top} left={contextMenu.left} onDismiss={closeContextMenu}>
          <View style={styles.contextMenu}>
            <Text style={styles.contextMenuLabel}>Rename (press Enter to save)</Text>
            {/* Deliberately no onBlur-commits-rename here -- this input is
                autoFocused, so clicking any other control below (a color
                swatch, Reset) blurs it first. Committing on blur would
                re-save the draft AFTER that control's own update already
                landed, silently clobbering whichever field the click was
                actually for. Enter is the only commit path. */}
            <TextInput
              style={styles.contextMenuInput}
              value={renameDraft}
              onChangeText={setRenameDraft}
              onSubmitEditing={commitRename}
              autoFocus
              selectTextOnFocus
            />
            <Text style={styles.contextMenuLabel}>Color</Text>
            <View style={styles.contextMenuSwatchRow}>
              {accentCycle.map((color) => (
                <Pressable
                  key={color}
                  onPress={() => {
                    onUpdateAccountOverride(contextMenu.accountId, { color });
                    closeContextMenu();
                  }}
                  style={[styles.contextMenuSwatch, { backgroundColor: color }]}
                />
              ))}
            </View>
            <Pressable
              onPress={() => {
                onUpdateAccountOverride(contextMenu.accountId, { label: undefined, color: undefined });
                closeContextMenu();
              }}
            >
              <Text style={styles.contextMenuReset}>Reset to default</Text>
            </Pressable>
          </View>
        </FloatingPortal>
      )}

      <SidebarFooterButton
        onPress={onOpenSettings}
        accentColor={accentColor}
        label="Settings"
        icon={(color) => (
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round">
            <circle cx={12} cy={12} r={3} />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          </svg>
        )}
      />
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
const footerHoverTransition: WebViewStyle = { transition: "background-color 150ms ease, border-color 150ms ease" };

interface SidebarFooterButtonProps {
  icon: (color: string) => ReactNode;
  label: string;
  accentColor: string;
  onPress: () => void;
}

// Settings, at the bottom of the sidebar -- a proper rounded chip rather
// than a flat edge-to-edge list row, with a permanent (if subtle) icon
// tint so it doesn't read as inert when not hovered. The icon/chip/label
// pick up the active account's accent color on hover, with a soft glow
// to match the weight of the Compose button above, plus a slight
// press-down for tactile feedback.
function SidebarFooterButton({ icon, label, accentColor, onPress }: SidebarFooterButtonProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }: HoverState) => [
        styles.settings,
        hovered && {
          backgroundColor: withAlpha(accentColor, 0.12),
          borderColor: withAlpha(accentColor, 0.4),
          shadowColor: accentColor,
        },
        { transform: [{ scale: pressed ? 0.97 : 1 }] },
      ]}
    >
      <View
        style={[
          styles.folderIcon,
          { backgroundColor: hovered ? withAlpha(accentColor, 0.22) : colors.background.surface },
        ]}
      >
        {icon(hovered ? accentColor : colors.text.muted)}
      </View>
      <Text style={[styles.folderLabel, styles.settingsLabel, hovered && { color: colors.text.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  contextMenu: {
    width: 200,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
  },
  contextMenuLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: spacing.xs,
  },
  contextMenuInput: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  contextMenuSwatchRow: {
    flexDirection: "row",
    marginBottom: spacing.md,
  },
  contextMenuSwatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    marginRight: spacing.sm,
  },
  contextMenuReset: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    textDecorationLine: "underline",
  },
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
    // Without this, a flex:1 ScrollView grows to fit all its content
    // instead of clipping to the space actually available -- the
    // classic flexbox gotcha where a flex child won't shrink below its
    // content's intrinsic size unless minHeight: 0 overrides the
    // implicit min-height: auto. Without it, the footer buttons below
    // get pushed past the bottom of the sidebar instead of the account
    // list actually scrolling.
    minHeight: 0,
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
    ...footerHoverTransition,
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
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: radii.md,
    marginTop: spacing.sm,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    ...footerHoverTransition,
  },
  settingsLabel: {
    fontWeight: "600",
  },
});
