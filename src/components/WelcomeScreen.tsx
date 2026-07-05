import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface WelcomeScreenProps {
  accentColor: string;
  onAddAccount: () => void;
}

// The one decorative element on this screen: a double helix drawn from
// dots, the product's name made visual. One strand carries the accent
// color, the other stays muted, with faint rungs where the strands are
// far enough apart to read as a ladder -- quiet enough to sit above the
// wordmark without competing with the button, which is the screen's job.
const HELIX_WIDTH = 190;
const HELIX_HEIGHT = 56;
const HELIX_MID = HELIX_HEIGHT / 2;
const HELIX_AMPLITUDE = 15;
const HELIX_TWISTS = 1.5;

const helixPoints = Array.from({ length: 15 }, (_, i) => {
  const x = 10 + i * ((HELIX_WIDTH - 20) / 14);
  const t = (i / 14) * Math.PI * 2 * HELIX_TWISTS;
  const offset = Math.sin(t) * HELIX_AMPLITUDE;
  return { x, yA: HELIX_MID + offset, yB: HELIX_MID - offset, spread: Math.abs(offset) };
});

function HelixMark({ accentColor }: { accentColor: string }) {
  return (
    <svg
      width={HELIX_WIDTH}
      height={HELIX_HEIGHT}
      viewBox={`0 0 ${HELIX_WIDTH} ${HELIX_HEIGHT}`}
      fill="none"
      aria-hidden
    >
      {helixPoints.map((p, i) => (
        <g key={i}>
          {p.spread > HELIX_AMPLITUDE * 0.55 && (
            <line x1={p.x} y1={p.yA} x2={p.x} y2={p.yB} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
          )}
          <circle cx={p.x} cy={p.yA} r={2.1} fill={withAlpha(accentColor, 0.9)} />
          <circle cx={p.x} cy={p.yB} r={2.1} fill="rgba(255,255,255,0.30)" />
        </g>
      ))}
    </svg>
  );
}

// Real properties of the app (see docs/technical/security.md), not
// slogans -- the audience for a self-hosted-friendly mail client reads
// spec labels, so these are set in mono like the data they are.
const FACTS = ["IMAP · POP3 · SMTP", "OS keychain", "Encrypted cache", "PGP · S/MIME"];

export function WelcomeScreen({ accentColor, onAddAccount }: WelcomeScreenProps) {
  return (
    <View style={styles.container}>
      {/* Accent glow behind the card */}
      <View
        style={[styles.cardGlow, { backgroundColor: withAlpha(accentColor, 0.18) }]}
        pointerEvents="none"
      />

      <View style={styles.card}>
        <View style={styles.helixMark}>
          <HelixMark accentColor={accentColor} />
        </View>

        <Text style={[styles.wordmark, { color: accentColor }]}>Helix</Text>

        <Text style={styles.tagline}>Private email, straight from your server.</Text>
        <Text style={styles.description}>
          Helix connects directly to your mail provider — no sync servers in
          between. Credentials stay in your OS keychain, and everything cached
          locally is encrypted.
        </Text>

        <View style={styles.factsRow}>
          {FACTS.map((fact) => (
            <View key={fact} style={styles.factChip}>
              <Text style={styles.factText}>{fact}</Text>
            </View>
          ))}
        </View>

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
          <Text style={[styles.githubLink, { color: accentColor }]}>
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
  cardGlow: {
    position: "absolute",
    width: 520,
    height: 520,
    borderRadius: 260,
    filter: "blur(90px)",
  } as never,
  card: {
    width: 520,
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: 48,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    ...glassPanel(colors.background.panel, 0.55, 48),
  },
  helixMark: {
    marginBottom: spacing.sm,
  },
  wordmark: {
    fontFamily: fontFamily.display,
    fontSize: 52,
    fontWeight: "700",
    letterSpacing: -2,
    marginBottom: spacing.sm,
  },
  tagline: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.md,
    fontWeight: "500",
    color: colors.text.primary,
    marginBottom: spacing.sm,
    textAlign: "center",
  },
  description: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    lineHeight: 20,
    color: colors.text.muted,
    textAlign: "center",
    maxWidth: 380,
    marginBottom: spacing.xl,
  },
  factsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: spacing.xs,
    // Narrow enough that the four chips break into two balanced pairs
    // instead of an off-kilter three-plus-one wrap.
    maxWidth: 320,
    marginBottom: spacing.xl,
  },
  factChip: {
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  factText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.3,
    color: colors.text.muted,
  },
  primaryButton: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md,
    marginBottom: spacing.md,
    shadowOpacity: 0.4,
    shadowRadius: 20,
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
  githubLink: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
