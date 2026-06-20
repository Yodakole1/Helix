import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface WelcomeScreenProps {
  accent: Accent;
  onAddAccount: () => void;
  onSkip: () => void;
}

// Shown in place of the 3-pane shell until an account is added (or skipped)
// for this session -- there's no persistence yet, so this is session-only
// state, not a real first-run flag. The skip path exists so the existing
// sample-data preview stays reachable without forcing setup every time.
export function WelcomeScreen({ accent, onAddAccount, onSkip }: WelcomeScreenProps) {
  const accentColor = colors.accent[accent];

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.wordmark}>Helix</Text>
        <Text style={styles.tagline}>
          Privacy-focused email, direct to your provider -- no middleman sync servers, no tracking.
        </Text>

        <Pressable
          onPress={onAddAccount}
          style={({ hovered }: HoverState) => [
            styles.primaryButton,
            { backgroundColor: accentColor, shadowColor: accentColor },
            hovered && styles.primaryButtonHovered,
          ]}
        >
          <Text style={styles.primaryButtonText}>Add your first account</Text>
        </Pressable>

        <Pressable onPress={onSkip} style={({ hovered }: HoverState) => [styles.skip, hovered && styles.skipHovered]}>
          <Text style={[styles.skipText, { color: accentColor }]}>Skip -- explore with sample data</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: 420,
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    ...glassPanel(colors.background.panel, 0.55, 30),
  },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.display,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: spacing.md,
  },
  tagline: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: spacing.xxl,
  },
  primaryButton: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  primaryButtonHovered: {
    opacity: 0.9,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  skip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  skipHovered: {
    backgroundColor: colors.background.surface,
  },
  skipText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
