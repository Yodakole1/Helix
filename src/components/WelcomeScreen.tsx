import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface WelcomeScreenProps {
  accentColor: string;
  onAddAccount: () => void;
}

// Shown in place of the 3-pane shell until at least one account is added.
// No skip path -- the app requires a real account to do anything useful.
export function WelcomeScreen({ accentColor, onAddAccount }: WelcomeScreenProps) {
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

        <a
          href="https://github.com/Yodakole1/Helix"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          <Text style={styles.githubLink}>Open source -- view on GitHub</Text>
        </a>
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
  githubLink: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginTop: spacing.lg,
  },
});
