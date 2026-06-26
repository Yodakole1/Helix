import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface WelcomeScreenProps {
  accentColor: string;
  onAddAccount: () => void;
}

const FEATURES = [
  { icon: "⇄", label: "Direct IMAP & POP3" },
  { icon: "⚿", label: "PGP encryption" },
  { icon: "✕", label: "No trackers, no sync servers" },
];

export function WelcomeScreen({ accentColor, onAddAccount }: WelcomeScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* Logo mark */}
        <View style={[styles.logoMark, { borderColor: withAlpha(accentColor, 0.5), shadowColor: accentColor }]}>
          <Text style={[styles.logoGlyph, { color: accentColor }]}>H</Text>
        </View>

        <Text style={styles.wordmark}>Helix</Text>
        <Text style={styles.tagline}>
          Privacy-first email. Connects directly to your provider — no middlemen, no tracking pixels, no data harvesting.
        </Text>

        {/* Feature strip */}
        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f.label} style={[styles.featurePill, { borderColor: withAlpha(accentColor, 0.25), backgroundColor: withAlpha(accentColor, 0.07) }]}>
              <Text style={[styles.featureIcon, { color: accentColor }]}>{f.icon}</Text>
              <Text style={styles.featureLabel}>{f.label}</Text>
            </View>
          ))}
        </View>

        <View style={[styles.divider, { backgroundColor: withAlpha(accentColor, 0.15) }]} />

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

        <Text style={styles.hint}>
          Supports standard IMAP/POP3 and SMTP — Gmail, Fastmail, Proton Bridge, self-hosted, and anything else.
        </Text>

        <a
          href="https://github.com/Yodakole1/Helix"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          <Text style={[styles.githubLink, { color: withAlpha(accentColor, 0.5) }]}>
            Open source · View on GitHub
          </Text>
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
    width: 460,
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    ...glassPanel(colors.background.panel, 0.6, 40),
  },
  logoMark: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  logoGlyph: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 34,
  },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.display,
    fontWeight: "700",
    color: colors.text.primary,
    marginBottom: spacing.sm,
    letterSpacing: -0.5,
  },
  tagline: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: spacing.xl,
  },
  features: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  featurePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  featureIcon: {
    fontSize: 13,
    marginRight: 6,
  },
  featureLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  divider: {
    alignSelf: "stretch",
    height: 1,
    marginBottom: spacing.xl,
  },
  primaryButton: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md,
    marginBottom: spacing.md,
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryButtonHovered: {
    opacity: 0.88,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.md,
    fontWeight: "700",
    color: colors.background.base,
    letterSpacing: 0.2,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  githubLink: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
