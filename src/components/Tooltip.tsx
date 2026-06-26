import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface TooltipProps {
  label: string;
  children: ReactNode;
}

// Hover-only label for icon-only controls. The trigger underneath is
// always a Pressable, and react-native-web's Pressable hardcodes
// `contain: true` on its hover gesture -- hovering a nested Pressable
// locks out any ancestor Pressable's own hover state, so wrapping with
// another Pressable here would simply never fire. A plain DOM wrapper
// with native mouse events sidesteps that (same reasoning as Splitter.tsx
// and the resize handle in ComposeModal -- web/Tauri-only).
export function Tooltip({ label, children }: TooltipProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "relative", display: "inline-flex" }}
    >
      {children}
      {hovered && (
        <View style={styles.bubble} pointerEvents="none">
          <Text style={styles.bubbleText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </div>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 6,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
  },
  bubbleText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.text.secondary,
  },
});
