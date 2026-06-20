import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { glassPanel } from "../lib/webStyle";
import type { HoverState } from "../lib/pressable";
import type { Accent } from "../theme";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ListIcon } from "./ListIcon";
import { Switch } from "./Switch";

export interface ComposePrefill {
  to: string;
  subject: string;
  quote: string;
}

interface ComposeModalProps {
  visible: boolean;
  accent: Accent;
  signature: string;
  prefill: ComposePrefill | null;
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
// what the composer should look like. "attach" is the one real action --
// see handleAttachClick.
const TOOLBAR_BUTTONS: ToolbarButton[] = [
  { id: "bold", glyph: "B", label: "Bold" },
  { id: "italic", glyph: "I", label: "Italic" },
  { id: "underline", glyph: "U", label: "Underline" },
  { id: "bullet", glyph: "•", label: "Bulleted list" },
  { id: "number", glyph: "1.", label: "Numbered list" },
  { id: "link", glyph: "⧉", label: "Insert link" },
  { id: "attach", glyph: "⬚", label: "Attach files" },
];

function buildBody(signature: string, quote?: string): string {
  const sig = signature.trim() === "" ? "" : `-- \n${signature}`;
  if (quote) return `\n\n${sig}${sig ? "\n\n" : ""}${quote}`;
  return sig === "" ? "" : `\n\n${sig}`;
}

// A docked corner popup, not a centered/blurring modal -- the point is to
// be able to read a message in the reader pane and reply to it at the same
// time, the way Gmail's compose works, rather than the rest of the app
// being blocked while writing.
export function ComposeModal({ visible, accent, signature, prefill, onClose }: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [encrypt, setEncrypt] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const accentColor = colors.accent[accent];

  useEscapeKey(visible, onClose);

  // Pre-fill a fresh compose with the reply context (if any) or just the
  // signature -- only when every field is still empty, so reopening an
  // in-progress draft never clobbers what's already been typed.
  useEffect(() => {
    if (!visible || to !== "" || subject !== "" || body !== "") return;
    if (prefill) {
      setTo(prefill.to);
      setSubject(prefill.subject);
      setBody(buildBody(signature, prefill.quote));
    } else if (signature.trim() !== "") {
      setBody(buildBody(signature));
    }
  }, [visible]);

  function reset() {
    setTo("");
    setShowCc(false);
    setCc("");
    setBcc("");
    setSubject("");
    setBody("");
    setActiveTool(null);
    setAttachments([]);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleAttachClick() {
    fileInputRef.current?.click();
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (files && files.length > 0) {
      setAttachments((current) => [...current, ...Array.from(files)]);
    }
    event.target.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  if (!visible) {
    return null;
  }

  return (
    <View style={[styles.card, { borderColor: accentColor }]}>
      <input ref={fileInputRef} type="file" multiple onChange={handleFilesSelected} style={{ display: "none" }} />

      <View style={styles.header}>
        <Text style={styles.title}>New message</Text>
        <Pressable onPress={handleClose}>
          <Text style={styles.close}>&#215;</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scrollBody}>
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
                onPress={() => (tool.id === "attach" ? handleAttachClick() : setActiveTool(active ? null : tool.id))}
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

        {attachments.length > 0 && (
          <View style={styles.attachmentChips}>
            {attachments.map((file, index) => (
              <View key={`${file.name}-${index}`} style={styles.attachmentChip}>
                <Text style={styles.attachmentChipText} numberOfLines={1}>
                  {file.name}
                </Text>
                <Pressable onPress={() => removeAttachment(index)}>
                  <ListIcon name="close" color={colors.text.muted} size={10} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <TextInput
          style={styles.body}
          value={body}
          onChangeText={setBody}
          placeholder="Write your message..."
          placeholderTextColor={colors.text.muted}
          multiline
          textAlignVertical="top"
        />
      </ScrollView>

      <View style={styles.footer}>
        <Pressable onPress={() => setEncrypt((value) => !value)} style={styles.encryptToggle}>
          <View style={styles.switchSpacer}>
            <Switch value={encrypt} onChange={() => setEncrypt((value) => !value)} color={accentColor} />
          </View>
          <Text style={styles.encryptLabel}>Encrypt</Text>
        </Pressable>

        <View style={styles.footerActions}>
          <Pressable onPress={handleClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
          <Pressable
            onPress={handleClose}
            style={[styles.sendButton, { backgroundColor: accentColor, shadowColor: accentColor }]}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    bottom: 0,
    right: 24,
    width: 520,
    maxHeight: "82%",
    borderWidth: 1,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderBottomWidth: 0,
    padding: spacing.lg,
    zIndex: 50,
    ...glassPanel(colors.background.panel, 0.7, 30),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text.primary,
  },
  close: {
    fontSize: fontSize.lg,
    color: colors.text.muted,
  },
  scrollBody: {
    flexGrow: 0,
  },
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
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
    marginRight: spacing.sm,
  },
  toolbarGlyph: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  attachmentChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: spacing.sm,
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 180,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  attachmentChipText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.secondary,
    marginRight: spacing.xs,
  },
  body: {
    minHeight: 180,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
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
