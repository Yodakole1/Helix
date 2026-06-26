import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface ModalOverlayProps {
  visible: boolean;
  accentColor: string;
  title: string;
  width?: number;
  // Takes over the whole viewport (minus a thin margin) instead of sizing
  // to `width` -- for screens that are really their own view (Settings),
  // not a dialog floating over the content behind it.
  fullScreen?: boolean;
  // Lower alpha = more see-through glass. Per-modal since some dialogs
  // (Compose) want a more transparent card than others.
  cardAlpha?: number;
  onClose: () => void;
  children: ReactNode;
}

// Shared chrome for every dialog in the app: a blurred full-screen scrim
// behind a glass card with a title bar. AddAccountModal and ComposeModal
// both build on this rather than each rolling their own overlay.
export function ModalOverlay({
  visible,
  accentColor,
  title,
  width = 440,
  fullScreen = false,
  cardAlpha = 0.92,
  onClose,
  children,
}: ModalOverlayProps) {
  useEscapeKey(visible, onClose);

  if (!visible) {
    return null;
  }

  const cardGlass = glassPanel(colors.background.panel, cardAlpha, 30);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View
        style={[styles.card, cardGlass, { borderColor: accentColor }, fullScreen ? styles.cardFullScreen : { width }]}
      >
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
    maxWidth: "92%",
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  cardFullScreen: {
    width: "97%",
    height: "95%",
    maxWidth: "97%",
    maxHeight: "95%",
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
