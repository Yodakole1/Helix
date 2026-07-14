import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface SyncIndicatorProps {
  accentColor: string;
}

// Small bottom-right pill, visible only while a folder/message fetch is in
// flight somewhere (App.tsx's syncingCount) -- adding an account, switching
// folders, a manual refresh, or a background poll/IDLE reconciliation all
// light it up. Deliberately separate from StatusToast (bottom-center,
// one-off confirmations): this one is ambient/passive, never demands
// attention, and disappears the instant the last in-flight fetch settles.
export function SyncIndicator({ accentColor }: SyncIndicatorProps) {
  // A plain opacity pulse rather than a spinner asset -- keeps this
  // dependency-free and consistent with the rest of the app's plain
  // StyleSheet-driven look.
  const [dim, setDim] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setDim((d) => !d), 700);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.pill, { borderColor: withAlpha(accentColor, 0.4) }]}>
        <View style={[styles.dot, { backgroundColor: accentColor, opacity: dim ? 0.35 : 1 }]} />
        <Text style={styles.label}>Syncing…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    bottom: 16,
    right: 16,
    zIndex: 9998,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.background.panel,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
});
