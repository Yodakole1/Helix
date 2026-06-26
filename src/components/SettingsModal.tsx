import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import type { HoverState } from "../lib/pressable";
import type { AccountId } from "../theme";
import { accentCycle, colors, fontFamily, fontSize, radii, spacing } from "../theme";
import type { Rule } from "../lib/rules";
import type { MessageTemplate } from "./ComposeModal";
import { ConnectedAccountsSettings } from "./ConnectedAccountsSettings";
import { DataStorageSettings } from "./DataStorageSettings";
import { ModalOverlay } from "./ModalOverlay";
import { NotificationSettings } from "./NotificationSettings";
import { PgpKeySettings } from "./PgpKeySettings";
import { RuleSettings } from "./RuleSettings";
import { settingsStyles } from "./settingsStyles";
import { Switch } from "./Switch";

type Category =
  | "accounts"
  | "notifications"
  | "storage"
  | "shortcuts"
  | "templates"
  | "rules"
  | "appearance"
  | "privacy"
  | "general"
  | "about";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "notifications", label: "Notifications" },
  { id: "storage", label: "Data & Storage" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "templates", label: "Templates" },
  { id: "rules", label: "Rules" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy & Security" },
  { id: "general", label: "General" },
  { id: "about", label: "About" },
];

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "C", description: "Compose a new message" },
  { keys: "/", description: "Focus the search box" },
  { keys: "R", description: "Reply to the open message" },
  { keys: "A", description: "Reply all" },
  { keys: "F", description: "Forward" },
  { keys: "E", description: "Archive the open message" },
  { keys: "Backspace / Delete", description: "Trash the open message" },
  { keys: "Cmd/Ctrl + ,", description: "Open Settings" },
  { keys: "Esc", description: "Close the open dialog" },
];

const GITHUB_URL = "https://github.com/Yodakole1/Helix";
const SPONSORS_URL = "https://github.com/sponsors/Yodakole1";

interface SettingsModalProps {
  visible: boolean;
  accountId: AccountId;
  // Real accounts from useAccounts(), same list the sidebar uses.
  accounts: MailAccount[];
  accentColor: string;
  accountOverrides: AccountOverrides;
  onUpdateAccountOverride: (accountId: AccountId, patch: { label?: string; color?: string }) => void;
  compactList: boolean;
  onToggleCompactList: () => void;
  signature: string;
  onSignatureChange: (signature: string) => void;
  encryptByDefault: boolean;
  onToggleEncryptByDefault: () => void;
  blockImages: boolean;
  onToggleBlockImages: () => void;
  unifiedInbox: boolean;
  onToggleUnifiedInbox: () => void;
  onAddAccount: () => void;
  templates: MessageTemplate[];
  onDeleteTemplate: (id: string) => void;
  rules: Rule[];
  onSaveRule: (rule: Rule) => void;
  onDeleteRule: (id: string) => void;
  onClose: () => void;
}

export function SettingsModal({
  visible,
  accountId,
  accounts,
  accentColor,
  accountOverrides,
  onUpdateAccountOverride,
  compactList,
  onToggleCompactList,
  signature,
  onSignatureChange,
  encryptByDefault,
  onToggleEncryptByDefault,
  blockImages,
  onToggleBlockImages,
  unifiedInbox,
  onToggleUnifiedInbox,
  onAddAccount,
  templates,
  onDeleteTemplate,
  rules,
  onSaveRule,
  onDeleteRule,
  onClose,
}: SettingsModalProps) {
  const [category, setCategory] = useState<Category>("accounts");
  const [readReceipts, setReadReceipts] = useState(false);
  const activeAccount = accounts.find((account) => account.id === accountId);
  const activeAccountLabel = activeAccount ? resolveAccountLabel(accountOverrides, activeAccount) : accountId;

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

          {category === "notifications" && <NotificationSettings accentColor={accentColor} />}

          {category === "storage" && <DataStorageSettings accentColor={accentColor} />}

          {category === "shortcuts" && (
            <View>
              <Text style={settingsStyles.sectionTitle}>Keyboard shortcuts</Text>
              <Text style={settingsStyles.hint}>
                Fixed for now, not yet rebindable. Inactive while typing in a text field or while a dialog is open.
              </Text>
              {SHORTCUTS.map((shortcut) => (
                <View key={shortcut.keys} style={styles.shortcutRow}>
                  <Text style={[styles.shortcutKeys, { borderColor: accentColor }]}>{shortcut.keys}</Text>
                  <Text style={styles.shortcutDescription}>{shortcut.description}</Text>
                </View>
              ))}
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
              <Text style={styles.sectionTitle}>Typography</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.display }]}>Space Grotesk -- headers</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.ui }]}>Inter -- body and UI text</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.mono }]}>JetBrains Mono -- technical data</Text>

              <Text style={styles.sectionTitle}>Accent palette -- {activeAccountLabel}</Text>
              <View style={styles.swatchRow}>
                {accentCycle.map((color) => (
                  <Pressable
                    key={color}
                    onPress={() => onUpdateAccountOverride(accountId, { color })}
                    style={[styles.swatch, { backgroundColor: color }, color === accentColor && styles.swatchActive]}
                  />
                ))}
              </View>
              <Text style={styles.hint}>
                Click a color to set it as the active account's accent -- the same override right-clicking it in the
                sidebar sets, just from here too.
              </Text>

              <Text style={styles.hint}>Dark mode is the only mode -- Helix is OLED-first by design.</Text>
            </View>
          )}

          {category === "privacy" && (
            <View>
              <SettingRow
                label="Block remote images"
                description="Stops senders from using tracking pixels in messages."
                value={blockImages}
                onChange={onToggleBlockImages}
                color={accentColor}
              />
              <SettingRow
                label="Send read receipts"
                description="Off by default -- Helix never confirms you've read a message without asking."
                value={readReceipts}
                onChange={() => setReadReceipts((value) => !value)}
                color={accentColor}
              />
              <SettingRow
                label="Encrypt new messages by default"
                description="Sets the starting state of the Encrypt toggle in compose. End-to-end encryption itself isn't implemented yet -- see docs/technical/encryption.md."
                value={encryptByDefault}
                onChange={onToggleEncryptByDefault}
                color={accentColor}
              />
              <Text style={styles.hint}>Account credentials are stored in your OS keychain, not in app storage.</Text>

              <PgpKeySettings
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
                value={compactList}
                onChange={onToggleCompactList}
                color={accentColor}
              />
              <SettingRow
                label="Unified inbox"
                description="Show every account's mail in one list instead of switching silos."
                value={unifiedInbox}
                onChange={onToggleUnifiedInbox}
                color={accentColor}
              />

              <Text style={styles.sectionTitle}>Signature</Text>
              <TextInput
                style={styles.signatureInput}
                value={signature}
                onChangeText={onSignatureChange}
                placeholder="Sent from Helix"
                placeholderTextColor={colors.text.muted}
                multiline
                textAlignVertical="top"
              />
              <Text style={styles.hint}>
                Appended to the body when you start a new message, the same way any signature does -- it only
                pre-fills an empty draft, so it never overwrites one already in progress.
              </Text>
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
                supporting its development.
              </Text>
              <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <Text style={[styles.sponsorButton, { backgroundColor: accentColor }]}>Sponsor on GitHub</Text>
              </a>
            </View>
          )}
        </ScrollView>
      </View>

      <View style={styles.footer}>
        <Pressable onPress={onClose} style={[styles.saveButton, { backgroundColor: accentColor, shadowColor: accentColor }]}>
          <Text style={styles.saveButtonText}>Save</Text>
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
  shortcutRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  shortcutKeys: {
    width: 140,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    marginRight: spacing.md,
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
    justifyContent: "flex-end",
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  saveButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  saveButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
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
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  content: {
    flex: 1,
  },
  sectionTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
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
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginTop: spacing.lg,
    lineHeight: 18,
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
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
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
  swatchRow: {
    flexDirection: "row",
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: spacing.sm,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchActive: {
    borderColor: colors.text.primary,
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
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 2,
  },
  settingDescription: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
});
