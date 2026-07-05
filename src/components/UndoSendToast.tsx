import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface UndoSendToastProps {
  outboxId: string;
  windowSeconds: number;
  onUndo: () => void;
  onDismiss: () => void;
}

// Timed toast shown after a message is queued with a future send_at. The
// countdown ticks down; pressing Undo cancels the queued item. When the
// countdown reaches zero the toast self-dismisses and the caller flushes
// the outbox (the message is already scheduled server-side, but flushing
// speeds it up if connectivity allows).
export function UndoSendToast({ outboxId: _outboxId, windowSeconds, onUndo, onDismiss }: UndoSendToastProps) {
  const [remaining, setRemaining] = useState(windowSeconds);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          // Small delay so the user sees "0" before it disappears.
          setTimeout(onDismiss, 400);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current!);
  }, []);

  function handleUndo() {
    clearInterval(intervalRef.current!);
    setUndone(true);
    onUndo();
    setTimeout(onDismiss, 1200);
  }

  return (
    <View style={styles.toast} pointerEvents="box-none">
      <View style={styles.card}>
        {undone ? (
          <Text style={styles.label}>Send cancelled.</Text>
        ) : (
          <>
            <Text style={styles.label}>
              Sending in <Text style={styles.countdown}>{remaining}s</Text>
            </Text>
            <Pressable onPress={handleUndo} style={styles.undoButton}>
              <Text style={styles.undoText}>Undo</Text>
            </Pressable>
          </>
        )}
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
    gap: spacing.md,
    backgroundColor: colors.background.panel,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  // Mono so the ticking digits keep a fixed width instead of nudging the
  // rest of the line every second.
  countdown: {
    fontFamily: fontFamily.mono,
    color: colors.text.primary,
    fontWeight: "700",
  },
  undoButton: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  undoText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.text.primary,
  },
});
