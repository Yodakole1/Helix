import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAnchorRect } from "../hooks/useAnchorRect";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { FloatingPortal } from "./FloatingPortal";
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

// Small floating picker (month/year, etc.). The menu is portaled (see
// FloatingPortal) so it escapes whatever this dropdown happens to be
// nested inside -- this is routinely a few levels deep (e.g. the custom
// date range inside the message list's filter panel), and a plain
// absolute/zIndex position would lose to unrelated later siblings of an
// ancestor several levels up.
export function Dropdown({ value, options, onChange, accentColor, width = 84 }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [anchorRef, rect] = useAnchorRect(open);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  return (
    <View style={[styles.wrapper, { width }]}>
      <Pressable
        ref={anchorRef}
        onPress={() => setOpen((current) => !current)}
        style={[styles.button, open && { borderColor: accentColor }]}
      >
        <Text style={styles.buttonText}>{selectedLabel}</Text>
        <ListIcon name="chevron-down" color={colors.text.muted} size={9} />
      </Pressable>
      {open && rect && (
        <FloatingPortal top={rect.bottom + 4} left={rect.left} onDismiss={() => setOpen(false)}>
          <View style={[styles.menu, { minWidth: rect.width }]}>
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
        </FloatingPortal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
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
  menu: {
    marginTop: 4,
    maxHeight: 180,
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
