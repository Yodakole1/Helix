import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface ModalOverlayProps {
  visible: boolean;
  accent: Accent;
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}

// Shared chrome for every dialog in the app: a blurred full-screen scrim
// behind a glass card with a title bar. AddAccountModal and ComposeModal
// both build on this rather than each rolling their own overlay.
export function ModalOverlay({ visible, accent, title, width = 440, onClose, children }: ModalOverlayProps) {
  if (!visible) {
    return null;
  }

  const accentColor = colors.accent[accent];

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.card, { borderColor: accentColor, width }]}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.close}>&#215;</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    ...glassPanel(colors.background.base, 0.55, 20),
  },
  card: {
    maxHeight: "90%",
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
    ...glassPanel(colors.background.panel, 0.92, 30),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  close: {
    fontSize: fontSize.lg,
    color: colors.text.muted,
  },
});
