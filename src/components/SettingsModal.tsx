import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import type { HoverState } from "../lib/pressable";
import type { AccountId, ThemeName } from "../theme";
import {
  avatarPaletteForStyle,
  type AvatarColorStyle,
  colors,
  EXTENDED_PALETTE,
  fontFamily,
  fontSize,
  radii,
  spacing,
  withAlpha,
} from "../theme";
import type { Rule } from "../lib/rules";
import { comboFromEvent, formatKeyCombo, isCompleteCombo, SHORTCUTS, type ShortcutId } from "../lib/shortcuts";
import type { MessageTemplate } from "./ComposeModal";
import CalDavSettings from "./CalDavSettings";
import { ConnectedAccountsSettings } from "./ConnectedAccountsSettings";
import { ContactsSettings } from "./ContactsSettings";
import { DataStorageSettings, type SyncDepth } from "./DataStorageSettings";
import { DebugSettings } from "./DebugLogSettings";
import { DefaultMailClientSettings } from "./DefaultMailClientSettings";
import { HexColorInput } from "./HexColorInput";
import { SmimeSettings } from "./SmimeSettings";
import { AppLockSettings } from "./AppLockSettings";
import { ModalOverlay } from "./ModalOverlay";
import { NotificationSettings } from "./NotificationSettings";
import { PgpKeySettings } from "./PgpKeySettings";
import { ImportExportSettings } from "./ImportExportSettings";
import { RuleSettings } from "./RuleSettings";
import { UpdateSettings } from "./UpdateSettings";
import { settingsStyles } from "./settingsStyles";
import { Switch } from "./Switch";

type Category =
  | "accounts"
  | "contacts"
  | "calendar"
  | "notifications"
  | "storage"
  | "shortcuts"
  | "templates"
  | "rules"
  | "appearance"
  | "privacy"
  | "general"
  | "about";

// General first, About pinned last, the rest roughly by how often they're
// reached for.
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "privacy", label: "Privacy & Security" },
  { id: "contacts", label: "Contacts" },
  { id: "calendar", label: "Calendar" },
  { id: "storage", label: "Data & Storage" },
  { id: "rules", label: "Rules" },
  { id: "templates", label: "Templates" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
];

const GITHUB_URL = "https://github.com/Yodakole1/Helix";
const SUPPORT_URL = "https://buymeacoffee.com/yodakole1";

// Text-size choices, applied as a whole-UI zoom factor (see App's fontScale).
const FONT_SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
  { value: 1.4, label: "Huge" },
];

const AVATAR_STYLE_OPTIONS: { value: AvatarColorStyle; label: string }[] = [
  { value: "muted", label: "Muted" },
  { value: "balanced", label: "Balanced" },
  { value: "vivid", label: "Vivid" },
];

const THEME_OPTIONS: { value: ThemeName; label: string; description: string }[] = [
  { value: "dark", label: "Dark", description: "OLED-first, the original Helix look." },
  { value: "light", label: "Light", description: "Soft gray-whites -- easy on the eyes, not glaring." },
];

// Every staged (Save/Done-applied) setting in one object. The modal edits a
// local draft of this and nothing touches the app until Save or Done --
// closing any other way discards the draft.
export interface SettingsValues {
  compactList: boolean;
  unifiedInbox: boolean;
  conversationView: boolean;
  separateUnread: boolean;
  blockImages: boolean;
  readReceipts: boolean;
  encryptByDefault: boolean;
  signature: string;
  spellCheck: boolean;
  syncDepth: SyncDepth;
  fontScale: number;
  theme: ThemeName;
  avatarColorStyle: AvatarColorStyle;
}

interface SettingsModalProps {
  visible: boolean;
  accountId: AccountId;
  // Real accounts from useAccounts(), same list the sidebar uses.
  accounts: MailAccount[];
  accentColor: string;
  accountOverrides: AccountOverrides;
  onUpdateAccountOverride: (accountId: AccountId, patch: { label?: string; color?: string }) => void;
  // Current applied settings; the modal stages edits locally until Save/Done.
  values: SettingsValues;
  onApply: (values: SettingsValues) => void;
  onAddAccount: () => void;
  templates: MessageTemplate[];
  onDeleteTemplate: (id: string) => void;
  rules: Rule[];
  onSaveRule: (rule: Rule) => void;
  onDeleteRule: (id: string) => void;
  shortcutBindings: Record<ShortcutId, string>;
  onRebindShortcut: (id: ShortcutId, combo: string) => void;
  onResetShortcuts: () => void;
  onClose: () => void;
}

export function SettingsModal({
  visible,
  accountId,
  accounts,
  accentColor,
  accountOverrides,
  onUpdateAccountOverride,
  values,
  onApply,
  onAddAccount,
  templates,
  onDeleteTemplate,
  rules,
  onSaveRule,
  onDeleteRule,
  shortcutBindings,
  onRebindShortcut,
  onResetShortcuts,
  onClose,
}: SettingsModalProps) {
  const [category, setCategory] = useState<Category>("general");
  const activeAccount = accounts.find((account) => account.id === accountId);
  const activeAccountLabel = activeAccount ? resolveAccountLabel(accountOverrides, activeAccount) : accountId;

  // The staged draft. Re-seeded from the live values every time the modal
  // opens, so a previously discarded draft never leaks into a new session.
  const [draft, setDraft] = useState<SettingsValues>(values);
  useEffect(() => {
    if (visible) setDraft(values);
  }, [visible]);

  function patchDraft(patch: Partial<SettingsValues>) {
    setDraft((current) => ({ ...current, ...patch }));
    setJustSaved(false);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(values);

  // Flips the Save button's label to "Saved" for a few seconds so the
  // click has visible confirmation, since Save (unlike Done) doesn't
  // close the dialog.
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  // Shortcut rebinding: null when idle, otherwise the id currently waiting
  // for the next keypress. Captured at the window level (rather than a
  // focused input) so any key combo, including ones that aren't normally
  // typeable, can be recorded directly.
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  useEffect(() => {
    if (!recordingId) return;
    const target = recordingId;
    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }
      if (!isCompleteCombo(event)) return; // a bare modifier isn't a binding yet
      onRebindShortcut(target, comboFromEvent(event));
      setRecordingId(null);
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingId, onRebindShortcut]);

  return (
    <ModalOverlay visible={visible} accentColor={accentColor} title="Settings" fullScreen onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.nav}>
          {CATEGORIES.map((item) => {
            const active = item.id === category;
            return (
              <Pressable
                key={item.id}
                onPress={() => setCategory(item.id)}
                style={({ hovered }: HoverState) => [
                  styles.navItem,
                  active && { backgroundColor: colors.background.surface, borderColor: accentColor },
                  !active && hovered && { backgroundColor: colors.background.surface },
                ]}
              >
                <Text style={[styles.navLabel, active && { color: colors.text.primary }]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <ScrollView style={styles.content}>
          {category === "accounts" && (
            <View>
              <Text style={styles.sectionTitle}>Connected accounts</Text>
              {accounts.map((account, index) => (
                <View
                  key={account.id}
                  style={[styles.accountRow, account.id === accountId && styles.accountRowActive]}
                >
                  <View
                    style={[styles.accountDot, { backgroundColor: resolveAccountColor(accountOverrides, account.id, index) }]}
                  />
                  <View style={styles.accountText}>
                    <Text style={styles.accountLabel}>{resolveAccountLabel(accountOverrides, account)}</Text>
                    <Text style={styles.accountEmail}>{account.email}</Text>
                  </View>
                  {account.id === accountId && <Text style={[styles.activeBadge, { color: accentColor }]}>Active</Text>}
                </View>
              ))}
              {accounts.length === 0 && (
                <Text style={styles.hint}>No accounts added yet. Use "Add account" below to connect your first mailbox.</Text>
              )}
              <Text style={styles.hint}>
                Right-click an account in the sidebar to rename it or change its color.
              </Text>

              <ConnectedAccountsSettings accentColor={accentColor} onAddAccount={onAddAccount} />
            </View>
          )}

          {category === "contacts" && <ContactsSettings accentColor={accentColor} />}

          {category === "calendar" && <CalDavSettings accentColor={accentColor} />}

          {category === "notifications" && <NotificationSettings accentColor={accentColor} />}

          {category === "storage" && (
            <View>
              <DataStorageSettings
                accentColor={accentColor}
                syncDepth={draft.syncDepth}
                onSyncDepthChange={(depth) => patchDraft({ syncDepth: depth })}
              />
              <Text style={settingsStyles.sectionTitle}>Import &amp; export</Text>
              <ImportExportSettings accentColor={accentColor} />
            </View>
          )}

          {category === "shortcuts" && (
            <View>
              <View style={styles.shortcutsHeader}>
                <Text style={settingsStyles.sectionTitle}>Keyboard shortcuts</Text>
                <Pressable onPress={onResetShortcuts}>
                  <Text style={[styles.shortcutReset, { color: accentColor }]}>Reset to defaults</Text>
                </Pressable>
              </View>
              <Text style={settingsStyles.hint}>
                Click a key combo to rebind it -- press any key (with modifiers if you like), or Esc to cancel.
                Inactive while typing in a text field or while a dialog is open.
              </Text>
              {SHORTCUTS.map((shortcut) => {
                const recording = recordingId === shortcut.id;
                return (
                  <View key={shortcut.id} style={styles.shortcutRow}>
                    <Pressable
                      onPress={() => setRecordingId(shortcut.id)}
                      style={({ hovered }: HoverState) => [
                        styles.shortcutKeys,
                        { borderColor: accentColor },
                        recording && { backgroundColor: withAlpha(accentColor, 0.14) },
                        !recording && hovered && { backgroundColor: withAlpha(accentColor, 0.08) },
                      ]}
                    >
                      <Text style={[styles.shortcutKeysText, recording && { color: accentColor }]}>
                        {recording ? "Press a key…" : formatKeyCombo(shortcutBindings[shortcut.id])}
                      </Text>
                    </Pressable>
                    <Text style={styles.shortcutDescription}>{shortcut.label}</Text>
                  </View>
                );
              })}
            </View>
          )}

          {category === "templates" && (
            <View>
              <Text style={settingsStyles.sectionTitle}>Saved templates</Text>
              <Text style={settingsStyles.hint}>
                Insert one from Compose's Templates button (next to Attach), or save the current draft as a new one
                from there.
              </Text>
              {templates.length === 0 && <Text style={settingsStyles.hint}>No templates saved yet.</Text>}
              {templates.map((template) => (
                <View key={template.id} style={styles.templateRow}>
                  <View style={styles.templateText}>
                    <Text style={styles.templateName}>{template.name}</Text>
                    <Text style={styles.templateSubject} numberOfLines={1}>
                      {template.subject || "(no subject)"}
                    </Text>
                  </View>
                  <Pressable onPress={() => onDeleteTemplate(template.id)}>
                    <Text style={styles.templateDelete}>Delete</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {category === "rules" && (
            <RuleSettings accentColor={accentColor} rules={rules} onSaveRule={onSaveRule} onDeleteRule={onDeleteRule} />
          )}

          {category === "appearance" && (
            <View>
              <Text style={styles.sectionTitle}>Theme</Text>
              <View style={styles.fontScaleRow}>
                {THEME_OPTIONS.map((option) => {
                  const active = draft.theme === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => patchDraft({ theme: option.value })}
                      style={[styles.themeCard, active && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.08) }]}
                    >
                      <View
                        style={[
                          styles.themePreview,
                          option.value === "dark"
                            ? { backgroundColor: "#0D0D11", borderColor: "rgba(255,255,255,0.2)" }
                            : { backgroundColor: "#F3F4F7", borderColor: "rgba(20,24,34,0.2)" },
                        ]}
                      >
                        <View
                          style={[
                            styles.themePreviewLine,
                            { backgroundColor: option.value === "dark" ? "#D6D6DE" : "#3A3D46" },
                          ]}
                        />
                        <View
                          style={[
                            styles.themePreviewLine,
                            { width: 22, backgroundColor: option.value === "dark" ? "#9C9CA8" : "#6C7078" },
                          ]}
                        />
                      </View>
                      <Text style={[styles.themeCardLabel, active && { color: accentColor }]}>{option.label}</Text>
                      <Text style={styles.themeCardDescription}>{option.description}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.hint}>Applies when you hit Save (the app reloads to switch its palette).</Text>

              <Text style={styles.sectionTitle}>Text size</Text>
              <View style={styles.fontScaleRow}>
                {FONT_SCALE_OPTIONS.map((option) => {
                  const active = draft.fontScale === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => patchDraft({ fontScale: option.value })}
                      style={[styles.fontScalePill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                    >
                      <Text style={[styles.fontScalePillText, active && { color: colors.background.base }]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.hint}>Scales all text and controls. Applies when you hit Save.</Text>

              <Text style={styles.sectionTitle}>Accent color -- {activeAccountLabel}</Text>
              <View style={styles.swatchGrid}>
                {EXTENDED_PALETTE.map((color) => (
                  <Pressable
                    key={color}
                    onPress={() => onUpdateAccountOverride(accountId, { color })}
                    style={[styles.swatch, { backgroundColor: color }, color === accentColor && styles.swatchActive]}
                  />
                ))}
              </View>
              <View style={styles.customColorRow}>
                <Text style={styles.customColorLabel}>Custom:</Text>
                {/* Applies immediately like the swatches (accent overrides
                    are not staged; they're the same override the sidebar
                    sets). */}
                <HexColorInput
                  value={accentColor}
                  onChange={(color) => onUpdateAccountOverride(accountId, { color })}
                />
              </View>
              <Text style={styles.hint}>
                Sets the active account's accent -- the color used for highlights across all three panes. The same
                override right-clicking the account in the sidebar sets, just from here too.
              </Text>

              <Text style={styles.sectionTitle}>Avatar colors</Text>
              <Text style={styles.hint}>
                Sender and contact letter avatars in the inbox and address book -- every starting letter gets its
                own distinct color, so "A" and "M" senders never blend together. Choose how loud those colors are.
              </Text>
              <View style={styles.avatarPreviewRow}>
                {avatarPaletteForStyle(draft.avatarColorStyle).map((color, index) => (
                  <View key={color + index} style={[styles.avatarPreviewCircle, { backgroundColor: color }]}>
                    <Text style={styles.avatarPreviewLetter}>{String.fromCharCode(65 + index)}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.fontScaleRow}>
                {AVATAR_STYLE_OPTIONS.map((option) => {
                  const active = draft.avatarColorStyle === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => patchDraft({ avatarColorStyle: option.value })}
                      style={[styles.fontScalePill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
                    >
                      <Text style={[styles.fontScalePillText, active && { color: colors.background.base }]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.hint}>Applies when you hit Save (the app reloads, same as switching theme).</Text>

              <Text style={styles.sectionTitle}>Typography</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.display }]}>Space Grotesk -- headers</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.ui }]}>Inter -- body and UI text</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.mono }]}>JetBrains Mono -- technical data</Text>
            </View>
          )}

          {category === "privacy" && (
            <View>
              <SettingRow
                label="Block remote images"
                description="Stops senders from using tracking pixels in messages."
                value={draft.blockImages}
                onChange={() => patchDraft({ blockImages: !draft.blockImages })}
                color={accentColor}
              />
              <SettingRow
                label="Send read receipts"
                description="Off by default -- Helix never confirms you've read a message without asking."
                value={draft.readReceipts}
                onChange={() => patchDraft({ readReceipts: !draft.readReceipts })}
                color={accentColor}
              />
              <SettingRow
                label="Encrypt new messages by default"
                description="Sets the starting state of the Encrypt toggle in compose. Sending encrypted requires a PGP key for every recipient -- compose checks for one automatically (WKD) and warns when it can't find one."
                value={draft.encryptByDefault}
                onChange={() => patchDraft({ encryptByDefault: !draft.encryptByDefault })}
                color={accentColor}
              />
              <Text style={styles.hint}>Account credentials are stored in your OS keychain, not in app storage.</Text>

              <AppLockSettings accentColor={accentColor} />

              <PgpKeySettings
                accountId={accountId}
                accountLabel={activeAccountLabel}
                accentColor={accentColor}
              />

              <SmimeSettings
                accountId={accountId}
                accountLabel={activeAccountLabel}
                accentColor={accentColor}
              />
            </View>
          )}

          {category === "general" && (
            <View>
              <SettingRow
                label="Compact message list"
                description="Tighter rows and smaller avatars in the inbox."
                value={draft.compactList}
                onChange={() => patchDraft({ compactList: !draft.compactList })}
                color={accentColor}
              />
              <SettingRow
                label="Unified inbox"
                description="Show every account's mail in one list instead of switching silos."
                value={draft.unifiedInbox}
                onChange={() => patchDraft({ unifiedInbox: !draft.unifiedInbox })}
                color={accentColor}
              />
              <SettingRow
                label="Conversation view"
                description="Group a folder's messages into threads, showing one row per conversation with its replies expandable. Off in the unified inbox."
                value={draft.conversationView}
                onChange={() => patchDraft({ conversationView: !draft.conversationView })}
                color={accentColor}
              />
              <SettingRow
                label="Separate unread from read"
                description="Splits the message list into an Unread section on top and a Read section under it."
                value={draft.separateUnread}
                onChange={() => patchDraft({ separateUnread: !draft.separateUnread })}
                color={accentColor}
              />
              <SettingRow
                label="Check spelling as you type"
                description="Underlines misspellings in the compose subject and body using your OS dictionaries -- fully offline."
                value={draft.spellCheck}
                onChange={() => patchDraft({ spellCheck: !draft.spellCheck })}
                color={accentColor}
              />

              <Text style={styles.sectionTitle}>Signature</Text>
              <TextInput
                style={styles.signatureInput}
                value={draft.signature}
                onChangeText={(text) => patchDraft({ signature: text })}
                placeholder="Sent from Helix"
                placeholderTextColor={colors.text.muted}
                multiline
                textAlignVertical="top"
              />
              <Text style={styles.hint}>
                Appended to the body when you start a new message, the same way any signature does -- it only
                pre-fills an empty draft, so it never overwrites one already in progress.
              </Text>

              <DefaultMailClientSettings accentColor={accentColor} />
            </View>
          )}

          {category === "about" && (
            <View>
              <Text style={styles.sectionTitle}>Helix</Text>
              <Text style={styles.aboutText}>
                A privacy-focused, open-source email client -- direct connections to your mail provider, no
                middleman sync servers, local encryption, and a dark, customizable interface. Still in early
                development; see docs/user/overview.md in the repo for what's real today versus what's planned.
              </Text>
              {/* Plain <a>, not a Tauri shell-open call -- this app has no
                  shell plugin/capability wired up yet, so this only opens
                  in the OS browser as expected if Tauri's default
                  target="_blank" handling does that for this build. */}
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <Text style={[styles.aboutLink, { color: accentColor }]}>View source on GitHub &#8599;</Text>
              </a>

              <Text style={styles.sectionTitle}>Support Helix</Text>
              <Text style={styles.aboutText}>
                Helix is built and maintained as an open-source project. If it's useful to you, consider
                buying the developer a coffee.
              </Text>
              <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <Text style={[styles.sponsorButton, { backgroundColor: accentColor }]}>Buy me a coffee</Text>
              </a>

              <Text style={styles.sectionTitle}>Updates</Text>
              <Text style={styles.aboutText}>
                Updates are downloaded from the official release feed and cryptographically verified before they
                install -- a tampered package is rejected. Helix only checks when you ask it to.
              </Text>
              <UpdateSettings accentColor={accentColor} />

              <DebugSettings accentColor={accentColor} />
            </View>
          )}
        </ScrollView>
      </View>

      <View style={styles.footer}>
        {/* Nothing applies until one of these: Save applies and keeps the
            dialog open, Done applies and closes. Closing any other way
            (Esc, the X) discards the draft. */}
        {dirty && <Text style={styles.unsavedHint}>Unsaved changes</Text>}
        <Pressable
          onPress={() => {
            onApply(draft);
            setJustSaved(true);
          }}
          style={[styles.saveButton, styles.saveButtonSecondary, dirty && { borderColor: accentColor }]}
        >
          <Text style={[styles.saveButtonSecondaryText, dirty && { color: accentColor }]}>
            {justSaved ? "Saved" : "Save"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            onApply(draft);
            onClose();
          }}
          style={[styles.saveButton, { backgroundColor: accentColor, shadowColor: accentColor }]}
        >
          <Text style={styles.saveButtonText}>Done</Text>
        </Pressable>
      </View>
    </ModalOverlay>
  );
}

interface SettingRowProps {
  label: string;
  description: string;
  value: boolean;
  onChange: () => void;
  color: string;
}

function SettingRow({ label, description, value, onChange, color }: SettingRowProps) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingInfo}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDescription}>{description}</Text>
      </View>
      <Switch value={value} onChange={onChange} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  shortcutsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  shortcutReset: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  shortcutRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  shortcutKeys: {
    width: 140,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    marginRight: spacing.md,
  },
  shortcutKeysText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    textAlign: "center",
  },
  shortcutDescription: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
  },
  templateText: {
    flex: 1,
    marginRight: spacing.md,
  },
  templateName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  templateSubject: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  templateDelete: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  unsavedHint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginRight: spacing.sm,
  },
  saveButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  saveButtonSecondary: {
    borderWidth: 1,
    borderColor: colors.border.subtle,
    shadowOpacity: 0,
  },
  saveButtonSecondaryText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.text.secondary,
  },
  saveButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  fontScaleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  fontScalePill: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  fontScalePillText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  nav: {
    width: 160,
    marginRight: spacing.lg,
  },
  navItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
    marginBottom: 2,
  },
  navLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.base,
    color: colors.text.secondary,
  },
  content: {
    flex: 1,
  },
  sectionTitle: {
    fontFamily: fontFamily.ui,
    fontSize: 12,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  accountRowActive: {
    backgroundColor: colors.background.surface,
  },
  accountDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
  },
  accountText: {
    flex: 1,
  },
  accountLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  accountEmail: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.muted,
  },
  activeBadge: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "600",
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: 12.5,
    color: colors.text.muted,
    marginTop: spacing.lg,
    lineHeight: 19,
  },
  signatureInput: {
    minHeight: 90,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  aboutText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.base,
    color: colors.text.secondary,
    lineHeight: 21,
    marginBottom: spacing.md,
  },
  aboutLink: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    marginBottom: spacing.lg,
  },
  sponsorButton: {
    alignSelf: "flex-start",
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  sample: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  avatarPreviewRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: spacing.sm,
  },
  avatarPreviewCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  avatarPreviewLetter: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  swatchGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    maxWidth: 6 * (28 + spacing.sm),
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchActive: {
    borderColor: colors.text.primary,
  },
  customColorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  customColorLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  themeCard: {
    width: 168,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.md,
    marginBottom: spacing.sm,
  },
  themePreview: {
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    padding: spacing.sm,
    gap: 5,
    marginBottom: spacing.sm,
  },
  themePreviewLine: {
    height: 4,
    width: 48,
    borderRadius: 2,
  },
  themeCardLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.text.primary,
    marginBottom: 2,
  },
  themeCardDescription: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 16,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  settingInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  settingLabel: {
    fontFamily: fontFamily.ui,
    fontSize: 15,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 2,
  },
  settingDescription: {
    fontFamily: fontFamily.ui,
    fontSize: 12.5,
    color: colors.text.muted,
    lineHeight: 18,
  },
});
