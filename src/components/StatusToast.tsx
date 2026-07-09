import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface StatusToastProps {
  // What happened, e.g. `Downloaded "report.pdf" to Downloads`.
  message: string;
  // "success" gets the accent check, "error" the amber tone, "info" a
  // neutral in-progress ellipsis (for "Downloading…"-style states that a
  // follow-up success/error toast replaces).
  kind?: "success" | "error" | "info";
  accentColor: string;
  onDismiss: () => void;
  // Auto-dismiss delay; the toast is informational, not interactive.
  durationMs?: number;
}

// Bottom-center status pill, same placement and look as UndoSendToast so
// one-off confirmations ("Downloaded successfully") read as part of the
// same system rather than a second toast style.
export function StatusToast({ message, kind = "success", accentColor, onDismiss, durationMs = 4000 }: StatusToastProps) {
  useEffect(() => {
    // In-progress toasts stay up until replaced or dismissed by the caller.
    if (kind === "info") return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [message, kind]);

  const tone = kind === "error" ? colors.accent.amber : accentColor;

  return (
    <View style={styles.toast} pointerEvents="box-none">
      <View style={[styles.card, { borderColor: withAlpha(tone, 0.5) }]}>
        <Text style={[styles.icon, { color: tone }]}>
          {kind === "success" ? "✓" : kind === "error" ? "⚠" : "…"}
        </Text>
        <Text style={styles.label} numberOfLines={2}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 9999,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: 520,
    backgroundColor: colors.background.panel,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  icon: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
});
