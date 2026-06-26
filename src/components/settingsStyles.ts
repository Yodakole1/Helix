import { StyleSheet } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

// Shared visual language for every Settings category section
// (PgpKeySettings, ConnectedAccountsSettings, DataStorageSettings,
// NotificationSettings, and SettingsModal's own inline categories) --
// pulled out once enough of these existed that copy-pasting the same
// section-title/hint/button/setting-row styles into each new file would
// have started drifting out of sync with each other.
export const settingsStyles = StyleSheet.create({
  sectionTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  textarea: {
    minHeight: 90,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: "row",
  },
  primaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
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
