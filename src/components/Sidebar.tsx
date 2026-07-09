import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import { folderLabel, normalizeFolderId } from "../data/folders";
import { listCalDavSources, type CalDavSource } from "../lib/caldav";
import { emitCalendarBus, onCalendarBus } from "../lib/calendarBus";
import type { AddressBookSource } from "./AddressBookView";
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
  // Folder operations (create/rename/delete IMAP folders, empty a folder's
  // contents). Optional -- omitted in sample/non-Tauri contexts.
  onCreateFolder?: (accountId: AccountId, name: string) => void;
  onRenameFolder?: (accountId: AccountId, folder: string, newName: string) => void;
  onDeleteFolder?: (accountId: AccountId, folder: string) => void;
  onEmptyFolder?: (accountId: AccountId, folder: string) => void;
  // Flat map of "accountId:folder" -> unread count. Only entries where count > 0.
  unreadCounts?: Record<string, number>;
  onCompose: () => void;
  onOpenCalendar: () => void;
  onOpenContacts?: () => void;
  onOpenSettings: () => void;
  // Address-book mode (a contacts tab is active): the sidebar lists the
  // available address books instead of mail folders or calendars, and
  // selecting one filters the AddressBookView.
  contactsMode?: boolean;
  addressBookSources?: AddressBookSource[];
  selectedAddressBookKey?: string;
  onSelectAddressBook?: (key: string) => void;
  // False while a calendar tab is active -- the account/folder tree is mail
  // navigation, and clicking into it wouldn't do anything useful from the
  // calendar view (there's no "current folder" concept there), so it's
  // hidden rather than left showing as dead-looking chrome. Also hides the
  // Compose button for the same reason: composing mail isn't a calendar action.
  showAccountList?: boolean;
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
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onEmptyFolder,
  unreadCounts,
  onCompose,
  onOpenCalendar,
  onOpenContacts,
  onOpenSettings,
  contactsMode = false,
  addressBookSources = [],
  selectedAddressBookKey = "all",
  onSelectAddressBook,
  showAccountList = true,
  width,
  overlay = false,
  onDismissOverlay,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<AccountId, boolean>>({});
  // Connected CalDAV calendars -- shown in place of the account/folder tree
  // while a calendar tab is active (showAccountList false), so the sidebar
  // is calendar navigation instead of empty chrome. Kept in sync with
  // CalendarView's mutations via the calendar bus.
  const [calendars, setCalendars] = useState<CalDavSource[]>([]);
  useEffect(() => {
    if (showAccountList || contactsMode) return;
    const load = () => {
      listCalDavSources().then(setCalendars).catch(() => setCalendars([]));
    };
    load();
    return onCalendarBus("sources-changed", load);
  }, [showAccountList, contactsMode]);

  const [contextMenu, setContextMenu] = useState<{ accountId: AccountId; top: number; left: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Folder context menu (right-click a folder) and its rename draft.
  const [folderMenu, setFolderMenu] = useState<{ accountId: AccountId; folder: string; top: number; left: number } | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState("");
  // Which account currently has its inline "new folder" input open, and its value.
  const [newFolderFor, setNewFolderFor] = useState<AccountId | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  function openFolderMenu(event: React.MouseEvent, forAccountId: AccountId, folder: string) {
    event.preventDefault();
    if (!onRenameFolder && !onDeleteFolder && !onEmptyFolder) return;
    setFolderRenameDraft(folder);
    setFolderMenu({ accountId: forAccountId, folder, top: event.clientY, left: event.clientX });
  }

  function closeFolderMenu() {
    setFolderMenu(null);
  }

  function commitNewFolder(forAccountId: AccountId) {
    const trimmed = newFolderName.trim();
    if (trimmed !== "") onCreateFolder?.(forAccountId, trimmed);
    setNewFolderFor(null);
    setNewFolderName("");
  }

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

      {showAccountList && (
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
      )}

      <ScrollView style={styles.accounts}>
        {!showAccountList && contactsMode && (
          <View>
            <Text style={styles.calSectionTitle}>Address books</Text>
            {addressBookSources.map((source) => {
              const active = source.key === selectedAddressBookKey;
              return (
                <Pressable
                  key={source.key}
                  onPress={() => onSelectAddressBook?.(source.key)}
                  style={({ hovered }: HoverState) => [
                    styles.calRow,
                    active && { backgroundColor: colors.background.surface },
                    !active && hovered && { backgroundColor: colors.background.surface },
                  ]}
                >
                  <View style={[styles.accountDot, { backgroundColor: active ? accentColor : colors.text.muted }]} />
                  <Text style={[styles.calName, active && { color: colors.text.primary }]} numberOfLines={1}>
                    {source.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {!showAccountList && !contactsMode && (
          <View>
            <Text style={styles.calSectionTitle}>Calendars</Text>
            {calendars.length === 0 && (
              <Text style={styles.calEmpty}>No calendars connected.</Text>
            )}
            {/* No inline remove here on purpose -- an × next to every row is
                one misclick away from deleting a calendar. Removal lives in
                Settings > Calendar, behind an explicit Remove action. */}
            {calendars.map((cal) => (
              <View key={cal.id} style={styles.calRow}>
                <View style={[styles.accountDot, { backgroundColor: cal.color ?? accentColor }]} />
                <Text style={styles.calName} numberOfLines={1}>
                  {cal.display_name || cal.username}
                </Text>
              </View>
            ))}
          </View>
        )}
        {showAccountList && accounts.map((account, accountIndex) => {
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
                  const folderUnread = unreadCounts?.[`${account.id}:${rawFolder}`] ?? 0;
                  return (
                    <div key={rawFolder} onContextMenu={(event) => openFolderMenu(event, account.id, rawFolder)}>
                      <Pressable
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
                        {folderUnread > 0 && (
                          <View style={[styles.unreadBadge, { backgroundColor: withAlpha(folderColor, 0.22) }]}>
                            <Text style={[styles.unreadBadgeText, { color: folderColor }]}>
                              {folderUnread > 99 ? "99+" : folderUnread}
                            </Text>
                          </View>
                        )}
                      </Pressable>
                    </div>
                  );
                })}
                {onCreateFolder &&
                  (newFolderFor === account.id ? (
                    <TextInput
                      style={styles.newFolderInput}
                      value={newFolderName}
                      onChangeText={setNewFolderName}
                      onSubmitEditing={() => commitNewFolder(account.id)}
                      onBlur={() => commitNewFolder(account.id)}
                      placeholder="New folder name"
                      placeholderTextColor={colors.text.muted}
                      autoFocus
                    />
                  ) : (
                    <Pressable
                      onPress={() => {
                        setNewFolderFor(account.id);
                        setNewFolderName("");
                      }}
                      style={({ hovered }: HoverState) => [styles.newFolderRow, hovered && { backgroundColor: colors.background.surface }]}
                    >
                      <Text style={styles.newFolderText}>+ New folder</Text>
                    </Pressable>
                  ))}
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

      {folderMenu && (
        <FloatingPortal top={folderMenu.top} left={folderMenu.left} onDismiss={closeFolderMenu}>
          <View style={styles.contextMenu}>
            <Text style={styles.contextMenuLabel} numberOfLines={1}>
              {folderLabel(folderMenu.folder)}
            </Text>
            {onRenameFolder && (
              <>
                <Text style={styles.contextMenuLabel}>Rename (Enter to save)</Text>
                <TextInput
                  style={styles.contextMenuInput}
                  value={folderRenameDraft}
                  onChangeText={setFolderRenameDraft}
                  onSubmitEditing={() => {
                    const trimmed = folderRenameDraft.trim();
                    if (trimmed !== "" && trimmed !== folderMenu.folder) onRenameFolder(folderMenu.accountId, folderMenu.folder, trimmed);
                    closeFolderMenu();
                  }}
                  autoFocus
                  selectTextOnFocus
                />
              </>
            )}
            {onEmptyFolder && (
              <Pressable
                onPress={() => {
                  onEmptyFolder(folderMenu.accountId, folderMenu.folder);
                  closeFolderMenu();
                }}
              >
                <Text style={styles.folderMenuAction}>Empty folder</Text>
              </Pressable>
            )}
            {onDeleteFolder && (
              <Pressable
                onPress={() => {
                  onDeleteFolder(folderMenu.accountId, folderMenu.folder);
                  closeFolderMenu();
                }}
              >
                <Text style={styles.folderMenuDanger}>Delete folder</Text>
              </Pressable>
            )}
          </View>
        </FloatingPortal>
      )}

      <SidebarFooterButton
        onPress={onOpenCalendar}
        accentColor={accentColor}
        label="Calendar"
        icon={(color) => (
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        )}
      />
      {onOpenContacts && (
        <SidebarFooterButton
          onPress={onOpenContacts}
          accentColor={accentColor}
          label="Address Book"
          icon={(color) => (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z" />
              <line x1="4" y1="4" x2="4" y2="20" />
              <circle cx="11.5" cy="10" r="2" />
              <path d="M8 16c.6-1.8 1.9-2.7 3.5-2.7s2.9.9 3.5 2.7" />
            </svg>
          )}
        />
      )}
      {!showAccountList && !contactsMode && (
        <SidebarFooterButton
          onPress={() => emitCalendarBus("open-add-calendar")}
          accentColor={accentColor}
          label="Add calendar"
          icon={(color) => (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
              <line x1="12" y1="13" x2="12" y2="19" />
              <line x1="9" y1="16" x2="15" y2="16" />
            </svg>
          )}
        />
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
  folderMenuAction: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    paddingVertical: 6,
  },
  folderMenuDanger: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.accent.amber,
    paddingVertical: 6,
  },
  newFolderRow: {
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    marginBottom: 2,
  },
  newFolderText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  newFolderInput: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    marginBottom: 2,
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
    maxHeight: 800,
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
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  unreadBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    marginLeft: spacing.xs,
  },
  unreadBadgeText: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "700",
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
  calSectionTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  calEmpty: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    paddingHorizontal: spacing.xs,
  },
  calRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  calName: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  calRemove: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    paddingHorizontal: 4,
  },
});
