import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { searchContacts, type ContactRecord } from "../lib/contacts";
import { useAnchorRect } from "../hooks/useAnchorRect";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";

interface AddressFieldProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  accentColor: string;
  placeholder?: string;
  trailing?: ReactNode;
}

// To/Cc/Bcc all need the same shape: committed recipients render as
// removable chips, separate from whatever's still being typed, with
// suggestions (via search_contacts from the local encrypted cache) for
// the in-progress entry. The suggestion list is
// portaled for the same reason the message list's filter/sort menus are
// (see FloatingPortal) -- it's nested inside the compose card's own flex
// layout, several stacking contexts deep.
export function AddressField({ label, value, onChange, accentColor, placeholder, trailing }: AddressFieldProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactRecord[]>([]);
  const [anchorRef, rect] = useAnchorRect(focused);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === "" || !focused) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    searchContacts(trimmed).then((results) => {
      if (!cancelled) setSuggestions(results.filter((c) => !value.includes(c.email)));
    });
    return () => { cancelled = true; };
  }, [draft, focused, value]);

  const open = focused && draft.trim() !== "" && suggestions.length > 0;

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "" || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
  }

  function handleChangeText(text: string) {
    if (text.includes(",")) {
      const [before, after] = [text.slice(0, text.indexOf(",")), text.slice(text.indexOf(",") + 1)];
      commit(before);
      setDraft(after);
      return;
    }
    setDraft(text);
  }

  function handleSubmit() {
    commit(draft);
    setDraft("");
  }

  function handleKeyPress(event: { nativeEvent: { key: string } }) {
    if (event.nativeEvent.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View ref={anchorRef} style={styles.inputArea}>
        {value.map((address, index) => (
          <View key={address} style={styles.chip}>
            <Text style={styles.chipText} numberOfLines={1}>
              {address}
            </Text>
            <Pressable onPress={() => removeAt(index)}>
              <ListIcon name="close" color={colors.text.muted} size={9} />
            </Pressable>
          </View>
        ))}
        <TextInput
          style={styles.draftInput}
          value={draft}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmit}
          onKeyPress={handleKeyPress}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            commit(draft);
            setDraft("");
            setFocused(false);
          }}
          placeholder={value.length === 0 ? placeholder : undefined}
          placeholderTextColor={colors.text.muted}
          autoCapitalize="none"
        />
      </View>
      {trailing}

      {open && rect && (
        <FloatingPortal top={rect.bottom + 4} left={rect.left}>
          <View style={[styles.suggestions, { minWidth: rect.width }]}>
            {suggestions.map((address) => (
              // Raw div + onMouseDown rather than Pressable's onPress: a
              // click on this row first blurs the (still-focused) text
              // input, and that blur handler closes this dropdown -- by
              // the time a click/onPress would fire, this row no longer
              // exists to receive it. preventDefault on mousedown stops
              // the focus shift (and so the blur) from happening at all.
              <SuggestionRow
                key={address.email}
                address={address}
                onSelect={() => {
                  commit(address.email);
                  setDraft("");
                  setSuggestions([]);
                }}
              />
            ))}
          </View>
        </FloatingPortal>
      )}
    </View>
  );
}

function SuggestionRow({ address, onSelect }: { address: ContactRecord; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: "pointer", backgroundColor: hovered ? colors.background.surface : "transparent" }}
    >
      <View style={styles.suggestionRow}>
        {address.display_name && (
          <Text style={styles.suggestionName}>{address.display_name}</Text>
        )}
        <Text style={styles.suggestionEmail}>{address.email}</Text>
      </View>
    </div>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  fieldLabel: {
    width: 56,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  inputArea: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    // A real address book search returns a handful of matches, but a
    // recipient list itself has no such cap -- someone pasting in or
    // building up dozens of addresses shouldn't grow this field (and so
    // the rest of the compose form below it) without bound. Scrolls
    // internally past ~3 rows of chips instead.
    maxHeight: 88,
    overflow: "scroll",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
    marginRight: spacing.xs,
    marginVertical: 2,
  },
  chipText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    marginRight: spacing.xs,
  },
  draftInput: {
    flex: 1,
    minWidth: 120,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    paddingVertical: 2,
  },
  suggestions: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "baseline",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  suggestionName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.primary,
    marginRight: spacing.sm,
  },
  suggestionEmail: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
  },
});
