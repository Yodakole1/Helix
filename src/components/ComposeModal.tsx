import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAnchorRect } from "../hooks/useAnchorRect";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { usePersistedState } from "../hooks/usePersistedState";
import { saveDraft, deleteDraft } from "../lib/drafts";
import { glassPanel } from "../lib/webStyle";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { AddressField } from "./AddressField";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";
import { Switch } from "./Switch";
import { Tooltip } from "./Tooltip";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const WIDTH_MIN = 380;
const WIDTH_MAX = 860;
const HEIGHT_MIN = 320;
const HEIGHT_MAX = 780;
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 560;

export interface ComposePrefill {
  to: string;
  // Empty for a fresh "to" (e.g. Forward, where the original recipients
  // aren't who this should go to) rather than carrying any address itself.
  cc?: string[];
  subject: string;
  quote: string;
  // RFC 5322 threading headers -- set for Reply/Reply-All, not Forward.
  inReplyTo?: string;
  references?: string[];
}

export interface MessageTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

interface ComposeModalProps {
  visible: boolean;
  accentColor: string;
  signature: string;
  encryptByDefault: boolean;
  prefill: ComposePrefill | null;
  templates: MessageTemplate[];
  onSaveTemplate: (name: string, subject: string, body: string) => void;
  // Called when the user presses Send. Throws on failure (the modal shows
  // the error and stays open); resolves on success (modal closes).
  onSend: (
    to: string[],
    cc: string[],
    subject: string,
    body: string,
    encrypt: boolean,
    attachments: File[],
    prefill: ComposePrefill | null,
  ) => Promise<void>;
  onClose: () => void;
  // When set, enables draft auto-save (every ~3 s after changes) and
  // discard-on-close. Undefined in browser-only dev mode.
  draftContext?: {
    accountId: string;
    imapHost: string;
    imapPort: number;
    draftsFolder: string;
  };
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
// what the composer should look like. Attach is the one real action in
// this toolbar, kept visually separate (its own icon, past a divider) so
// it doesn't read as just another inert formatting placeholder.
const FORMATTING_BUTTONS: ToolbarButton[] = [
  { id: "bold", glyph: "B", label: "Bold" },
  { id: "italic", glyph: "I", label: "Italic" },
  { id: "underline", glyph: "U", label: "Underline" },
  { id: "bullet", glyph: "•", label: "Bulleted list" },
  { id: "number", glyph: "1.", label: "Numbered list" },
  { id: "link", glyph: "⧉", label: "Insert link" },
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
export function ComposeModal({
  visible,
  accentColor,
  signature,
  encryptByDefault,
  prefill,
  templates,
  onSaveTemplate,
  onSend,
  onClose,
  draftContext,
}: ComposeModalProps) {
  const [to, setTo] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [encrypt, setEncrypt] = useState(encryptByDefault);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [width, setWidth] = usePersistedState("helix.compose.width", DEFAULT_WIDTH);
  const [height, setHeight] = usePersistedState("helix.compose.height", DEFAULT_HEIGHT);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [templatesAnchorRef, templatesAnchorRect] = useAnchorRect(templatesOpen);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sizeDragStart = useRef({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  // Stable draft id for the current compose session -- allows repeated
  // auto-saves to update the same row rather than create new ones.
  const draftIdRef = useRef<string | null>(null);

  useEscapeKey(visible, onClose);

  // Auto-save the draft 3 s after the last change. Only runs when
  // draftContext is set (i.e. a real account is available).
  useEffect(() => {
    if (!visible || !draftContext) return;
    const timer = window.setTimeout(() => {
      saveDraft({
        accountId: draftContext.accountId,
        imapHost: draftContext.imapHost,
        imapPort: draftContext.imapPort,
        draftsFolder: draftContext.draftsFolder,
        draftId: draftIdRef.current,
        to: to.join(", ") || null,
        subject: subject || null,
        bodyText: body || null,
        inReplyTo: prefill?.inReplyTo ?? null,
        references: prefill?.references ?? [],
      }).then((id) => { draftIdRef.current = id; }).catch(console.warn);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [visible, to, subject, body, draftContext]);

  // Dragging from the card's top-left corner: the card is pinned to the
  // bottom-right of the screen, so growing the box means moving that corner
  // up and to the left -- both deltas are subtracted, not added.
  function handleResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    sizeDragStart.current = { width, height };
    const startX = event.clientX;
    const startY = event.clientY;

    function handlePointerMove(moveEvent: PointerEvent) {
      setWidth(clamp(sizeDragStart.current.width - (moveEvent.clientX - startX), WIDTH_MIN, WIDTH_MAX));
      setHeight(clamp(sizeDragStart.current.height - (moveEvent.clientY - startY), HEIGHT_MIN, HEIGHT_MAX));
    }
    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  // Pre-fill a fresh compose with the reply context (if any) or just the
  // signature -- only when every field is still empty, so reopening an
  // in-progress draft never clobbers what's already been typed.
  useEffect(() => {
    if (!visible || to.length > 0 || subject !== "" || body !== "") return;
    if (prefill) {
      setTo(prefill.to ? [prefill.to] : []);
      if (prefill.cc && prefill.cc.length > 0) {
        setCc(prefill.cc);
        setShowCc(true);
      }
      setSubject(prefill.subject);
      setBody(buildBody(signature, prefill.quote));
    } else if (signature.trim() !== "") {
      setBody(buildBody(signature));
    }
  }, [visible]);

  function reset() {
    draftIdRef.current = null;
    setTo([]);
    setShowCc(false);
    setCc([]);
    setBcc([]);
    setSubject("");
    setBody("");
    setEncrypt(encryptByDefault);
    setActiveTool(null);
    setAttachments([]);
    setMinimized(false);
    setTemplatesOpen(false);
    setSavingTemplate(false);
    setNewTemplateName("");
    setSending(false);
    setSendError(null);
  }

  function handleClose() {
    // Delete the locally saved draft when the user explicitly discards --
    // they didn't send, and they closed, so the draft is unwanted.
    if (draftIdRef.current && draftContext) {
      deleteDraft({
        accountId: draftContext.accountId,
        imapHost: draftContext.imapHost,
        imapPort: draftContext.imapPort,
        draftsFolder: draftContext.draftsFolder,
        draftId: draftIdRef.current,
      }).catch(console.warn);
    }
    reset();
    onClose();
  }

  async function handleSend() {
    if (to.length === 0) {
      setSendError("Please add at least one recipient.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await onSend(to, cc, subject, body, encrypt, attachments, prefill ?? null);
      reset();
      onClose();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  // Subject only fills in if still empty (don't clobber one already
  // typed); body appends rather than replaces once there's already
  // content, so inserting a template is never destructive -- no
  // confirm-before-overwrite dialog needed.
  function handleInsertTemplate(template: MessageTemplate) {
    if (subject.trim() === "") setSubject(template.subject);
    setBody((current) => (current.trim() === "" ? template.body : `${current}\n\n${template.body}`));
    setTemplatesOpen(false);
  }

  function handleSaveTemplate() {
    const name = newTemplateName.trim();
    if (name === "") return;
    onSaveTemplate(name, subject, body);
    setSavingTemplate(false);
    setNewTemplateName("");
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
    <View style={[styles.card, { borderColor: accentColor, width }, !minimized && { height }]}>
      <input ref={fileInputRef} type="file" multiple onChange={handleFilesSelected} style={{ display: "none" }} />

      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {subject.trim() === "" ? "New message" : subject}
        </Text>
        <View style={styles.headerActions}>
          <Tooltip label={minimized ? "Expand" : "Minimize"}>
            <Pressable onPress={() => setMinimized((value) => !value)}>
              <ListIcon name={minimized ? "chevron-up" : "chevron-down"} color={colors.text.muted} size={14} />
            </Pressable>
          </Tooltip>
          <Tooltip label="Close">
            <Pressable onPress={handleClose}>
              <Text style={styles.close}>&#215;</Text>
            </Pressable>
          </Tooltip>
        </View>
      </View>

      {!minimized && (
      // Pinned to the card's own top-left corner rather than the
      // viewport's -- dragging it grows the card toward the top-left,
      // the only direction available since the card is docked to the
      // bottom-right edge of the screen.
      <div
        onPointerDown={handleResizeStart}
        style={{ position: "absolute", top: 0, left: 0, width: 16, height: 16, cursor: "nwse-resize", touchAction: "none" }}
      />
      )}

      {!minimized && (
      <>
      <View style={styles.formArea}>
        <AddressField
          label="To"
          value={to}
          onChange={setTo}
          accentColor={accentColor}
          placeholder="recipient@example.com"
          trailing={
            !showCc && (
              <Pressable onPress={() => setShowCc(true)}>
                <Text style={[styles.ccToggle, { color: accentColor }]}>Cc/Bcc</Text>
              </Pressable>
            )
          }
        />

        {showCc && (
          <>
            <AddressField label="Cc" value={cc} onChange={setCc} accentColor={accentColor} />
            <AddressField label="Bcc" value={bcc} onChange={setBcc} accentColor={accentColor} />
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
          {FORMATTING_BUTTONS.map((tool) => {
            const active = activeTool === tool.id;
            return (
              <Tooltip key={tool.id} label={tool.label}>
                <Pressable
                  onPress={() => setActiveTool(active ? null : tool.id)}
                  style={({ hovered }: HoverState) => [
                    styles.toolbarButton,
                    active && { backgroundColor: colors.background.surface, borderColor: accentColor },
                    !active && hovered && { backgroundColor: colors.background.surface },
                  ]}
                >
                  <Text style={[styles.toolbarGlyph, active && { color: accentColor }]}>{tool.glyph}</Text>
                </Pressable>
              </Tooltip>
            );
          })}

          <View style={styles.toolbarDivider} />

          <Tooltip label="Attach files">
            <Pressable
              onPress={handleAttachClick}
              style={({ hovered }: HoverState) => [styles.attachButton, hovered && { borderColor: accentColor }]}
            >
              <ListIcon name="attachment" color={colors.text.secondary} size={15} />
            </Pressable>
          </Tooltip>

          <View style={styles.toolbarDivider} />

          <Tooltip label="Templates">
            <Pressable
              ref={templatesAnchorRef}
              onPress={() => setTemplatesOpen((value) => !value)}
              style={({ hovered }: HoverState) => [
                styles.attachButton,
                (hovered || templatesOpen) && { borderColor: accentColor },
              ]}
            >
              <ListIcon name="template" color={colors.text.secondary} size={15} />
            </Pressable>
          </Tooltip>
        </View>

        {templatesOpen && templatesAnchorRect && (
          <FloatingPortal
            top={templatesAnchorRect.bottom + 4}
            left={templatesAnchorRect.left}
            onDismiss={() => setTemplatesOpen(false)}
          >
            <View style={[styles.templatesMenu, { minWidth: Math.max(templatesAnchorRect.width, 220) }]}>
              {templates.length === 0 && <Text style={styles.templatesEmpty}>No saved templates yet.</Text>}
              {templates.map((template) => (
                <Pressable
                  key={template.id}
                  onPress={() => handleInsertTemplate(template)}
                  style={({ hovered }: HoverState) => [styles.templateRow, hovered && { backgroundColor: colors.background.surface }]}
                >
                  <Text style={styles.templateName} numberOfLines={1}>
                    {template.name}
                  </Text>
                  <Text style={styles.templateSubject} numberOfLines={1}>
                    {template.subject || "(no subject)"}
                  </Text>
                </Pressable>
              ))}

              <View style={styles.templatesDivider} />

              {!savingTemplate ? (
                <Pressable
                  onPress={() => setSavingTemplate(true)}
                  disabled={subject.trim() === "" && body.trim() === ""}
                  style={styles.templateSaveToggle}
                >
                  <Text
                    style={[
                      styles.templateSaveToggleText,
                      { color: subject.trim() === "" && body.trim() === "" ? colors.text.muted : accentColor },
                    ]}
                  >
                    + Save current draft as template
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.templateSaveForm}>
                  <TextInput
                    style={styles.templateSaveInput}
                    value={newTemplateName}
                    onChangeText={setNewTemplateName}
                    placeholder="Template name"
                    placeholderTextColor={colors.text.muted}
                    autoFocus
                    onSubmitEditing={handleSaveTemplate}
                  />
                  <Pressable onPress={handleSaveTemplate}>
                    <Text style={[styles.templateSaveConfirm, { color: accentColor }]}>Save</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </FloatingPortal>
        )}

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
      </View>

      <View style={styles.footer}>
        <Pressable onPress={() => setEncrypt((value) => !value)} style={styles.encryptToggle}>
          <View style={styles.switchSpacer}>
            <Switch value={encrypt} onChange={() => setEncrypt((value) => !value)} color={accentColor} />
          </View>
          <Text style={styles.encryptLabel}>Encrypt</Text>
        </Pressable>

        <View style={styles.footerActions}>
          {sendError && <Text style={styles.sendError}>{sendError}</Text>}
          <Pressable onPress={handleClose} style={styles.secondaryButton} disabled={sending}>
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
          <Pressable
            onPress={handleSend}
            disabled={sending}
            style={[styles.sendButton, { backgroundColor: accentColor, shadowColor: accentColor }, sending && styles.sendButtonDisabled]}
          >
            <Text style={styles.sendButtonText}>{sending ? "Sending..." : "Send"}</Text>
          </Pressable>
        </View>
      </View>
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    bottom: 0,
    right: 24,
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
    flex: 1,
    marginRight: spacing.md,
    fontFamily: fontFamily.display,
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text.primary,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  close: {
    fontSize: fontSize.lg,
    color: colors.text.muted,
  },
  formArea: {
    flex: 1,
    minHeight: 0,
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
    alignItems: "center",
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
  toolbarDivider: {
    width: 1,
    height: 22,
    backgroundColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  attachButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
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
  templatesMenu: {
    maxWidth: 280,
    maxHeight: 280,
    overflow: "scroll",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
  },
  templatesEmpty: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  templateRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  templateName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  templateSubject: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  templatesDivider: {
    height: 1,
    backgroundColor: colors.border.subtle,
    marginVertical: spacing.xs,
  },
  templateSaveToggle: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  templateSaveToggleText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  templateSaveForm: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  templateSaveInput: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    paddingVertical: 4,
    marginRight: spacing.sm,
  },
  templateSaveConfirm: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  body: {
    flex: 1,
    minHeight: 0,
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
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendError: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: "#ff6b6b",
    flex: 1,
    marginRight: spacing.sm,
  },
});
