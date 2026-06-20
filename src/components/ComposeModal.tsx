import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import type { Accent } from "../theme";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ModalOverlay } from "./ModalOverlay";
import { Switch } from "./Switch";

interface ComposeModalProps {
  visible: boolean;
  accent: Accent;
  onClose: () => void;
}

interface ToolbarButton {
  id: string;
  glyph: string;
  label: string;
}

// Formatting controls a body of text would need. These are visual only for
// now -- wiring them up to actually format text means swapping the plain
// TextInput body for a real rich-text editor (contentEditable or a library
// like Tiptap/Lexical), which is a separate piece of work from laying out
// what the composer should look like.
const TOOLBAR_BUTTONS: ToolbarButton[] = [
  { id: "bold", glyph: "B", label: "Bold" },
  { id: "italic", glyph: "I", label: "Italic" },
  { id: "underline", glyph: "U", label: "Underline" },
  { id: "bullet", glyph: "•", label: "Bulleted list" },
  { id: "number", glyph: "1.", label: "Numbered list" },
  { id: "link", glyph: "⧉", label: "Insert link" },
  { id: "attach", glyph: "⬚", label: "Encrypted attachment" },
];

export function ComposeModal({ visible, accent, onClose }: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [encrypt, setEncrypt] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>(null);

  const accentColor = colors.accent[accent];

  function reset() {
    setTo("");
    setShowCc(false);
    setCc("");
    setBcc("");
    setSubject("");
    setBody("");
    setActiveTool(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  return (
    <ModalOverlay visible={visible} accent={accent} title="New message" width={680} onClose={handleClose}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>To</Text>
        <TextInput
          style={styles.fieldInput}
          value={to}
          onChangeText={setTo}
          placeholder="recipient@example.com"
          placeholderTextColor={colors.text.muted}
          autoCapitalize="none"
        />
        {!showCc && (
          <Pressable onPress={() => setShowCc(true)}>
            <Text style={[styles.ccToggle, { color: accentColor }]}>Cc/Bcc</Text>
          </Pressable>
        )}
      </View>

      {showCc && (
        <>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Cc</Text>
            <TextInput
              style={styles.fieldInput}
              value={cc}
              onChangeText={setCc}
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Bcc</Text>
            <TextInput
              style={styles.fieldInput}
              value={bcc}
              onChangeText={setBcc}
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
            />
          </View>
        </>
      )}

      <View style={[styles.field, styles.fieldNoBorder]}>
        <Text style={styles.fieldLabel}>Subject</Text>
        <TextInput
          style={styles.fieldInput}
          value={subject}
          onChangeText={setSubject}
          placeholderTextColor={colors.text.muted}
        />
      </View>

      <View style={styles.toolbar}>
        {TOOLBAR_BUTTONS.map((tool) => {
          const active = activeTool === tool.id;
          return (
            <Pressable
              key={tool.id}
              onPress={() => setActiveTool(active ? null : tool.id)}
              style={({ hovered }: HoverState) => [
                styles.toolbarButton,
                active && { backgroundColor: colors.background.surface, borderColor: accentColor },
                !active && hovered && { backgroundColor: colors.background.surface },
              ]}
            >
              <Text style={[styles.toolbarGlyph, active && { color: accentColor }]}>{tool.glyph}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        style={styles.body}
        value={body}
        onChangeText={setBody}
        placeholder="Write your message..."
        placeholderTextColor={colors.text.muted}
        multiline
        textAlignVertical="top"
      />

      <View style={styles.footer}>
        <Pressable onPress={() => setEncrypt((value) => !value)} style={styles.encryptToggle}>
          <View style={styles.switchSpacer}>
            <Switch value={encrypt} onChange={() => setEncrypt((value) => !value)} color={accentColor} />
          </View>
          <Text style={styles.encryptLabel}>Encrypt with PGP</Text>
        </Pressable>

        <View style={styles.footerActions}>
          <Pressable onPress={handleClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
          <Pressable
            onPress={handleClose}
            style={[
              styles.sendButton,
              { backgroundColor: accentColor, shadowColor: accentColor },
            ]}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </ModalOverlay>
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
  fieldNoBorder: {
    borderBottomWidth: 0,
  },
  fieldLabel: {
    width: 56,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  fieldInput: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    paddingVertical: 2,
  },
  ccToggle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  toolbar: {
    flexDirection: "row",
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  toolbarButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
    marginRight: spacing.xs,
  },
  toolbarGlyph: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  body: {
    minHeight: 200,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  encryptToggle: {
    flexDirection: "row",
    alignItems: "center",
  },
  switchSpacer: {
    marginRight: spacing.sm,
  },
  encryptLabel: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  footerActions: {
    flexDirection: "row",
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  sendButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    shadowOpacity: 0.6,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  sendButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
});
