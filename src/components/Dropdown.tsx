import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ListIcon } from "./ListIcon";

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  accentColor: string;
  width?: number;
}

// Small floating picker (month/year, etc.) -- self-contained, including its
// own oversized invisible backdrop to close on outside-click, since it has
// no shared parent state to coordinate that with. The backdrop is
// deliberately much bigger than the viewport could ever be: anchoring to
// this component's own tiny wrapper (the only "position: relative" box it
// has) means top:0/left:0/right:0/bottom:0 would only cover the wrapper
// itself, not the rest of the screen.
export function Dropdown({ value, options, onChange, accentColor, width = 84 }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  return (
    <View style={[styles.wrapper, { width }]}>
      <Pressable
        onPress={() => setOpen((current) => !current)}
        style={[styles.button, open && { borderColor: accentColor }]}
      >
        <Text style={styles.buttonText}>{selectedLabel}</Text>
        <ListIcon name="chevron-down" color={colors.text.muted} size={9} />
      </Pressable>
      {open && (
        <>
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
          <View style={styles.menu}>
            {options.map((option) => {
              const active = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={({ hovered }: HoverState) => [
                    styles.menuItem,
                    active && { backgroundColor: colors.background.surface },
                    !active && hovered && { backgroundColor: colors.background.surface },
                  ]}
                >
                  <Text style={[styles.menuItemText, active && { color: accentColor }]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
    zIndex: 5,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
  },
  buttonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  backdrop: {
    position: "absolute",
    top: -2000,
    left: -2000,
    width: 5000,
    height: 5000,
  },
  menu: {
    position: "absolute",
    top: "100%",
    left: 0,
    marginTop: 4,
    maxHeight: 180,
    minWidth: "100%",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
    overflow: "scroll",
  },
  menuItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  menuItemText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
});
