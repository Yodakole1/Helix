import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ACCOUNTS } from "../data/accounts";
import type { HoverState } from "../lib/pressable";
import type { Accent } from "../theme";
import { accentCycle, colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ModalOverlay } from "./ModalOverlay";
import { Switch } from "./Switch";

type Category = "accounts" | "appearance" | "privacy" | "general";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy & Security" },
  { id: "general", label: "General" },
];

interface SettingsModalProps {
  visible: boolean;
  accent: Accent;
  compactList: boolean;
  onToggleCompactList: () => void;
  signature: string;
  onSignatureChange: (signature: string) => void;
  onClose: () => void;
}

export function SettingsModal({
  visible,
  accent,
  compactList,
  onToggleCompactList,
  signature,
  onSignatureChange,
  onClose,
}: SettingsModalProps) {
  const [category, setCategory] = useState<Category>("accounts");
  const [blockImages, setBlockImages] = useState(true);
  const [readReceipts, setReadReceipts] = useState(false);
  const [unifiedInbox, setUnifiedInbox] = useState(false);

  const accentColor = colors.accent[accent];

  return (
    <ModalOverlay visible={visible} accent={accent} title="Settings" width={900} onClose={onClose}>
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
              {ACCOUNTS.map((account) => (
                <View key={account.id} style={styles.accountRow}>
                  <View style={[styles.accountDot, { backgroundColor: colors.accent[account.id] }]} />
                  <View style={styles.accountText}>
                    <Text style={styles.accountLabel}>{account.label}</Text>
                    <Text style={styles.accountEmail}>{account.email}</Text>
                  </View>
                </View>
              ))}
              <Text style={styles.hint}>
                Account setup is wizard-only right now -- editing or removing an account here isn&apos;t wired up
                yet.
              </Text>
            </View>
          )}

          {category === "appearance" && (
            <View>
              <Text style={styles.sectionTitle}>Typography</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.display }]}>Space Grotesk -- headers</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.ui }]}>Inter -- body and UI text</Text>
              <Text style={[styles.sample, { fontFamily: fontFamily.mono }]}>JetBrains Mono -- technical data</Text>

              <Text style={styles.sectionTitle}>Accent palette</Text>
              <View style={styles.swatchRow}>
                {accentCycle.map((color) => (
                  <View key={color} style={[styles.swatch, { backgroundColor: color }]} />
                ))}
              </View>

              <Text style={styles.hint}>Dark mode is the only mode -- Helix is OLED-first by design.</Text>
            </View>
          )}

          {category === "privacy" && (
            <View>
              <SettingRow
                label="Block remote images"
                description="Stops senders from using tracking pixels in messages."
                value={blockImages}
                onChange={() => setBlockImages((value) => !value)}
                color={accentColor}
              />
              <SettingRow
                label="Send read receipts"
                description="Off by default -- Helix never confirms you've read a message without asking."
                value={readReceipts}
                onChange={() => setReadReceipts((value) => !value)}
                color={accentColor}
              />
              <Text style={styles.hint}>Account credentials are stored in your OS keychain, not in app storage.</Text>
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
                onChange={() => setUnifiedInbox((value) => !value)}
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
    flexDirection: "row",
    minHeight: 480,
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
