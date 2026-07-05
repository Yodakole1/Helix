import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAnchorRect } from "../hooks/useAnchorRect";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { usePersistedState } from "../hooks/usePersistedState";
import { resolveAccountColor, resolveAccountLabel, type AccountOverrides, type MailAccount } from "../data/accounts";
import { saveDraft, deleteDraft } from "../lib/drafts";
import type { IdentitySummary } from "../lib/identities";
import { discoverPgpKeyWkd, importContactKey } from "../lib/pgp";
import { fileToBase64 } from "../lib/smtp";
import { glassPanel } from "../lib/webStyle";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha, type AccountId } from "../theme";
import { AddressField } from "./AddressField";
import { FloatingPortal } from "./FloatingPortal";
import { ListIcon } from "./ListIcon";
import { RichTextEditor, applyFormat, escapeHtml, htmlToPlainText } from "./RichTextEditor";
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
  // Every account the user has added -- lets the compose window send from
  // any of them, not just whichever mailbox happens to be open in the
  // sidebar. Only rendered as a picker when there's more than one.
  accounts: MailAccount[];
  accountOverrides: AccountOverrides;
  // Which account is currently selected to send from. Controlled by the
  // parent (defaulted to the active sidebar account when compose opens) so
  // draft auto-save and the identities list below stay in sync with it.
  fromAccountId: AccountId;
  onFromAccountChange: (accountId: AccountId) => void;
  // Additional send-as identities for the selected account; when non-empty,
  // a From: alias picker appears underneath the account picker.
  identities: IdentitySummary[];
  signature: string;
  encryptByDefault: boolean;
  prefill: ComposePrefill | null;
  templates: MessageTemplate[];
  onSaveTemplate: (name: string, subject: string, body: string) => void;
  // Called when the user presses Send or Send Later. Throws on failure (the
  // modal shows the error and stays open); resolves on success (modal closes).
  // `fromOverride` is null when sending from the account's primary address.
  // `sendAt` is an RFC 3339 timestamp for Send Later; null for normal send.
  // `htmlBody` is the rich-text HTML body; null when composing plain text.
  onSend: (
    to: string[],
    cc: string[],
    bcc: string[],
    subject: string,
    body: string,
    encrypt: boolean,
    attachments: File[],
    prefill: ComposePrefill | null,
    fromOverride: string | null,
    sendAt: string | null,
    htmlBody?: string | null,
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

// Formatting controls for the rich-text body. All real: each applies a
// document.execCommand to the contentEditable editor (see RichTextEditor).
// Rich text is the default compose mode; the RT toggle drops to plain text
// (which PGP-encrypted sends require).
const FORMATTING_BUTTONS: ToolbarButton[] = [
  { id: "bold", glyph: "B", label: "Bold" },
  { id: "italic", glyph: "I", label: "Italic" },
  { id: "underline", glyph: "U", label: "Underline" },
  { id: "bullet", glyph: "•", label: "Bulleted list" },
  { id: "number", glyph: "1.", label: "Numbered list" },
  { id: "link", glyph: "⧉", label: "Insert link" },
];

// One staged attachment. `version` counts replacements: attaching a file
// with the same name swaps it in place and bumps the version (so sending an
// updated document doesn't quietly duplicate it), and compressing does the
// same. Shown as a "v2"+ chip so the swap is visible.
interface StagedAttachment {
  file: File;
  version: number;
}

const COMPRESS_THRESHOLD_BYTES = 1024 * 1024;
const COMPRESS_MAX_DIMENSION = 2048;

function isCompressibleImage(file: File): boolean {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size > COMPRESS_THRESHOLD_BYTES;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// Downscales to a screen-sized long edge and re-encodes as JPEG -- the
// built-in "this photo doesn't need to be 8 MB" tool. Returns the smaller
// file; callers keep the original if compression doesn't actually win.
async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, COMPRESS_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas context");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image encode failed"))), "image/jpeg", 0.8),
  );
  const baseName = file.name.replace(/\.(png|webp|jpe?g)$/i, "");
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}

function buildBody(signature: string, quote?: string): string {
  const sig = signature.trim() === "" ? "" : `-- \n${signature}`;
  if (quote) return `\n\n${sig}${sig ? "\n\n" : ""}${quote}`;
  return sig === "" ? "" : `\n\n${sig}`;
}

// Auto-inserts slashes as the user types digits: "01072026" -> "01/07/2026".
function formatDateAsTyped(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("/");
}

// Combines a typed "DD/MM/YYYY" date with a native <input type="time">
// value ("HH:MM") into a string `new Date(...)` can parse, or null while
// either half is incomplete.
function combineSendLaterDateTime(dateText: string, timeText: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateText);
  if (!m || !timeText) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}T${timeText}`;
}

// A docked corner popup, not a centered/blurring modal -- the point is to
// be able to read a message in the reader pane and reply to it at the same
// time, the way Gmail's compose works, rather than the rest of the app
// being blocked while writing.
export function ComposeModal({
  visible,
  accentColor,
  accounts,
  accountOverrides,
  fromAccountId,
  onFromAccountChange,
  identities,
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
  // Which toggleable formats (bold/italic/underline/bullet/number) are
  // active at the current caret position -- a Set, not a single value,
  // since e.g. bold+italic+underline can all be on for the same text at
  // once. Kept in sync via syncActiveFormats() below.
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [width, setWidth] = usePersistedState("helix.compose.width", DEFAULT_WIDTH);
  const [height, setHeight] = usePersistedState("helix.compose.height", DEFAULT_HEIGHT);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  // Per-address WKD key discovery status, populated when Encrypt is on.
  // "checking" → in-flight, "found" → key discovered and auto-imported,
  // "not-found" → WKD lookup failed, user should import manually.
  const [wkdByEmail, setWkdByEmail] = useState<Record<string, "checking" | "found" | "not-found">>({});
  // Rich text is the default compose mode -- the formatting toolbar works
  // out of the box. Toggling off converts to plain text (needed for PGP).
  const [richText, setRichText] = useState(true);
  // Latest HTML from the rich-text editor, updated via onChange callback.
  const htmlBodyRef = useRef<string>("");
  // Content seeding for the editor: bumping version makes RichTextEditor
  // re-read html (programmatic content changes only -- typing never
  // round-trips through here).
  const [editorSeed, setEditorSeed] = useState({ version: 0, html: "" });
  function seedEditor(html: string) {
    htmlBodyRef.current = html;
    setEditorSeed((current) => ({ version: current.version + 1, html }));
  }
  function plainToHtml(text: string): string {
    return text ? escapeHtml(text).replace(/\n/g, "<br>") : "";
  }
  // Inline link-URL input (window.prompt doesn't exist in the webview).
  // The selection is captured when the Link button is pressed and restored
  // right before applying, since focusing the URL input collapses it.
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const savedSelectionRef = useRef<Range | null>(null);
  // null = sending from account's primary address; non-null = alias address.
  const [fromAddress, setFromAddress] = useState<string | null>(null);
  // From: alias picker dropdown state.
  const [fromPickerOpen, setFromPickerOpen] = useState(false);
  const [fromAnchorRef, fromAnchorRect] = useAnchorRect(fromPickerOpen);
  // Account picker dropdown state -- which of the user's added accounts to
  // send from, distinct from the alias picker above.
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [accountAnchorRef, accountAnchorRect] = useAnchorRect(accountPickerOpen);
  // Send Later: a typed "DD/MM/YYYY" date plus a native time-input value
  // ("HH:MM"), kept as two plain-text fields rather than a single
  // datetime-local input so the date format is fixed instead of shifting
  // with the browser's locale (see combineSendLaterDateTime below).
  const [sendLaterDateText, setSendLaterDateText] = useState("");
  const [sendLaterTimeText, setSendLaterTimeText] = useState("");
  const sendLaterAt = combineSendLaterDateTime(sendLaterDateText, sendLaterTimeText);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [templatesAnchorRef, templatesAnchorRect] = useAnchorRect(templatesOpen);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sizeDragStart = useRef({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  // Stable draft id for the current compose session -- allows repeated
  // auto-saves to update the same row rather than create new ones.
  const draftIdRef = useRef<string | null>(null);

  useEscapeKey(visible, onClose);

  // Aliases belong to a specific account -- switching which account sends
  // the message means any previously-picked alias no longer applies.
  useEffect(() => {
    setFromAddress(null);
  }, [fromAccountId]);

  // When Encrypt is on and the To list changes, run WKD discovery for any
  // address we haven't checked yet. Found keys are auto-imported so the next
  // send can actually encrypt without the user doing anything extra.
  useEffect(() => {
    if (!encrypt || to.length === 0) return;
    for (const address of to) {
      if (wkdByEmail[address] !== undefined) continue;
      setWkdByEmail((current) => ({ ...current, [address]: "checking" }));
      discoverPgpKeyWkd(address)
        .then((keyInfo) => {
          importContactKey(address, keyInfo.public_key).catch(() => {});
          setWkdByEmail((current) => ({ ...current, [address]: "found" }));
        })
        .catch(() => {
          setWkdByEmail((current) => ({ ...current, [address]: "not-found" }));
        });
    }
  }, [encrypt, to.join(",")]);

  // Auto-save the draft 3 s after the last change. Only runs when
  // draftContext is set (i.e. a real account is available).
  useEffect(() => {
    if (!visible || !draftContext) return;
    const timer = window.setTimeout(async () => {
      // Convert the staged File attachments to base64 so they're saved with
      // the draft and APPENDed to the server's Drafts folder, not dropped.
      const outgoing = await Promise.all(
        attachments.map(async ({ file }) => ({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          content_base64: await fileToBase64(file),
        })),
      );
      saveDraft({
        accountId: draftContext.accountId,
        imapHost: draftContext.imapHost,
        imapPort: draftContext.imapPort,
        draftsFolder: draftContext.draftsFolder,
        draftId: draftIdRef.current,
        to: to.join(", ") || null,
        subject: subject || null,
        bodyText: body || null,
        bodyHtml: richText && htmlBodyRef.current ? htmlBodyRef.current : null,
        inReplyTo: prefill?.inReplyTo ?? null,
        references: prefill?.references ?? [],
        attachments: outgoing,
      }).then((id) => { draftIdRef.current = id; }).catch(console.warn);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [visible, to, subject, body, attachments, draftContext]);

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
      const built = buildBody(signature, prefill.quote);
      setBody(built);
      seedEditor(plainToHtml(built));
    } else if (signature.trim() !== "") {
      const built = buildBody(signature);
      setBody(built);
      seedEditor(plainToHtml(built));
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
    setActiveFormats(new Set());
    setAttachments([]);
    setMinimized(false);
    setTemplatesOpen(false);
    setSavingTemplate(false);
    setNewTemplateName("");
    setSending(false);
    setSendError(null);
    setWkdByEmail({});
    setFromAddress(null);
    setSendLaterDateText("");
    setSendLaterTimeText("");
    setSendLaterOpen(false);
    setFromPickerOpen(false);
    setAccountPickerOpen(false);
    setRichText(true);
    setLinkInputOpen(false);
    setLinkUrl("");
    savedSelectionRef.current = null;
    seedEditor("");
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

  async function handleSend(sendAt?: string | null) {
    if (to.length === 0) {
      setSendError("Please add at least one recipient.");
      return;
    }
    setSending(true);
    setSendError(null);
    // Convert datetime-local string to RFC 3339 for the backend.
    const rfc3339SendAt = sendAt
      ? new Date(sendAt).toISOString()
      : sendLaterAt
      ? new Date(sendLaterAt).toISOString()
      : null;
    // In rich text mode the plain body is stripped from the HTML; the HTML
    // itself is passed separately. When Encrypt is on, only the plain part
    // goes out -- the backend hard-rejects encrypt+HTML (inline PGP is
    // plain-text only), so sending the HTML alongside would fail the send.
    const plainBody = richText ? htmlToPlainText(htmlBodyRef.current) : body;
    const htmlBody = richText && htmlBodyRef.current && !encrypt ? htmlBodyRef.current : null;
    try {
      await onSend(to, cc, bcc, subject, plainBody, encrypt, attachments.map((a) => a.file), prefill ?? null, fromAddress, rfc3339SendAt, htmlBody);
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
    // In rich-text mode the editor owns its own DOM -- append the template
    // to the current HTML and re-seed, preserving any formatting so far.
    if (richText) {
      const addition = plainToHtml(template.body);
      const current = htmlBodyRef.current;
      seedEditor(current ? `${current}<br><br>${addition}` : addition);
    }
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

  // Re-reads which toggleable formats apply at the current caret/selection
  // so the toolbar reflects reality (e.g. bold+italic+underline can all be
  // active on the same text at once) instead of remembering "last button
  // clicked". Called after every applyFormat() and on selection changes
  // reported by RichTextEditor (typing, clicking, arrow keys).
  function syncActiveFormats() {
    const next = new Set<string>();
    if (document.queryCommandState("bold")) next.add("bold");
    if (document.queryCommandState("italic")) next.add("italic");
    if (document.queryCommandState("underline")) next.add("underline");
    if (document.queryCommandState("insertUnorderedList")) next.add("bullet");
    if (document.queryCommandState("insertOrderedList")) next.add("number");
    setActiveFormats(next);
  }

  // Restores the selection captured when the Link button was pressed, then
  // wraps it in a link. A bare domain gets https:// prefixed -- execCommand
  // would otherwise create a relative link that goes nowhere.
  function applyLink() {
    const url = linkUrl.trim();
    setLinkInputOpen(false);
    setLinkUrl("");
    if (url === "") return;
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const range = savedSelectionRef.current;
    if (range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    applyFormat("createLink", href);
    savedSelectionRef.current = null;
    syncActiveFormats();
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (files && files.length > 0) {
      const incoming = Array.from(files);
      setAttachments((current) => {
        const next = [...current];
        for (const file of incoming) {
          // Re-attaching a same-named file is a new version of the same
          // document, not a duplicate -- replace in place and count it.
          const existing = next.findIndex((a) => a.file.name === file.name);
          if (existing !== -1) next[existing] = { file, version: next[existing].version + 1 };
          else next.push({ file, version: 1 });
        }
        return next;
      });
    }
    event.target.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  async function handleCompressAttachment(index: number) {
    const entry = attachments[index];
    if (!entry) return;
    try {
      const compressed = await compressImage(entry.file);
      // Only swap if compression actually helped.
      if (compressed.size >= entry.file.size) return;
      setAttachments((current) =>
        current.map((a, i) => (i === index ? { file: compressed, version: a.version + 1 } : a)),
      );
    } catch (e) {
      console.warn("image compression failed:", e);
    }
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

        {/* Account picker -- which of the user's added accounts (could be
            many) this message sends from. Only worth showing a picker for
            when there's actually a choice. */}
        {accounts.length > 1 && (
          <View style={[styles.field, styles.fieldNoBorder]}>
            <Text style={styles.fieldLabel}>From</Text>
            <Pressable
              ref={accountAnchorRef}
              onPress={() => setAccountPickerOpen((v) => !v)}
              style={styles.fromPicker}
            >
              <Text style={styles.fromPickerText} numberOfLines={1}>
                {resolveAccountLabel(accountOverrides, accounts.find((a) => a.id === fromAccountId) ?? { id: fromAccountId, label: fromAccountId, email: fromAccountId })}
                {" "}
                <Text style={styles.fromPickerSubtext}>&lt;{fromAccountId}&gt;</Text>
              </Text>
              <ListIcon name="chevron-down" color={colors.text.muted} size={10} />
            </Pressable>
          </View>
        )}

        {accountPickerOpen && accountAnchorRect && (
          <FloatingPortal
            top={accountAnchorRect.bottom + 4}
            left={accountAnchorRect.left}
            onDismiss={() => setAccountPickerOpen(false)}
          >
            <View style={[styles.templatesMenu, { minWidth: Math.max(accountAnchorRect.width, 240) }]}>
              {accounts.map((account, index) => (
                <Pressable
                  key={account.id}
                  onPress={() => { onFromAccountChange(account.id); setAccountPickerOpen(false); }}
                  style={({ hovered }: HoverState) => [styles.templateRow, hovered && { backgroundColor: colors.background.surface }, fromAccountId === account.id && { backgroundColor: colors.background.surface }]}
                >
                  <View style={styles.accountRow}>
                    <View style={[styles.accountDot, { backgroundColor: resolveAccountColor(accountOverrides, account.id, index) }]} />
                    <Text style={[styles.templateName, fromAccountId === account.id && { color: accentColor }]} numberOfLines={1}>
                      {resolveAccountLabel(accountOverrides, account)}
                    </Text>
                  </View>
                  <Text style={styles.templateSubject} numberOfLines={1}>{account.id}</Text>
                </Pressable>
              ))}
            </View>
          </FloatingPortal>
        )}

        {/* From: alias picker -- only visible when the selected account has
            aliases defined, since its primary address is the implicit
            default when absent. */}
        {identities.length > 0 && (
          <View style={[styles.field, styles.fieldNoBorder]}>
            <Text style={styles.fieldLabel}>Alias</Text>
            <Pressable
              ref={fromAnchorRef}
              onPress={() => setFromPickerOpen((v) => !v)}
              style={styles.fromPicker}
            >
              <Text style={styles.fromPickerText} numberOfLines={1}>
                {fromAddress ?? fromAccountId}
              </Text>
              <ListIcon name="chevron-down" color={colors.text.muted} size={10} />
            </Pressable>
          </View>
        )}

        {fromPickerOpen && fromAnchorRect && (
          <FloatingPortal
            top={fromAnchorRect.bottom + 4}
            left={fromAnchorRect.left}
            onDismiss={() => setFromPickerOpen(false)}
          >
            <View style={[styles.templatesMenu, { minWidth: Math.max(fromAnchorRect.width, 240) }]}>
              {/* Primary address always first */}
              <Pressable
                onPress={() => { setFromAddress(null); setFromPickerOpen(false); }}
                style={({ hovered }: HoverState) => [styles.templateRow, hovered && { backgroundColor: colors.background.surface }, fromAddress === null && { backgroundColor: colors.background.surface }]}
              >
                <Text style={[styles.templateName, fromAddress === null && { color: accentColor }]} numberOfLines={1}>
                  {fromAccountId}
                </Text>
                <Text style={styles.templateSubject}>Primary address</Text>
              </Pressable>
              {identities.map((id) => (
                <Pressable
                  key={id.address}
                  onPress={() => { setFromAddress(id.address); setFromPickerOpen(false); }}
                  style={({ hovered }: HoverState) => [styles.templateRow, hovered && { backgroundColor: colors.background.surface }, fromAddress === id.address && { backgroundColor: colors.background.surface }]}
                >
                  <Text style={[styles.templateName, fromAddress === id.address && { color: accentColor }]} numberOfLines={1}>
                    {id.display_name ? `${id.display_name} <${id.address}>` : id.address}
                  </Text>
                  <Text style={styles.templateSubject}>Alias</Text>
                </Pressable>
              ))}
            </View>
          </FloatingPortal>
        )}

        {encrypt && to.length > 0 && (
          <View style={styles.wkdStatus}>
            {to.map((address) => {
              const status = wkdByEmail[address];
              if (!status) return null;
              return (
                <Text
                  key={address}
                  style={[
                    styles.wkdStatusText,
                    status === "found" && { color: colors.accent.green },
                    status === "not-found" && { color: colors.accent.amber },
                  ]}
                >
                  {status === "checking" && `Checking key for ${address}...`}
                  {status === "found" && `Key found for ${address} (via WKD)`}
                  {status === "not-found" && `No key for ${address} -- encryption will be skipped for them`}
                </Text>
              );
            })}
          </View>
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
          {/* Rich text toggle -- switches the body between a plain TextInput
              and a contentEditable RichTextEditor, converting the content
              in whichever direction it goes (formatting is lost dropping
              to plain, which is the point of plain). */}
          <Tooltip label={richText ? "Switch to plain text" : "Switch to rich text"}>
            <Pressable
              onPress={() => {
                if (richText) {
                  setBody(htmlToPlainText(htmlBodyRef.current));
                } else {
                  seedEditor(plainToHtml(body));
                }
                setLinkInputOpen(false);
                setRichText((v) => !v);
              }}
              style={({ hovered }: HoverState) => [
                styles.toolbarButton,
                richText && { backgroundColor: withAlpha(accentColor, 0.14), borderColor: accentColor },
                !richText && hovered && { backgroundColor: "rgba(255,255,255,0.06)" },
              ]}
            >
              <Text style={[styles.toolbarGlyph, richText && { color: accentColor }]}>RT</Text>
            </Pressable>
          </Tooltip>
          <View style={styles.toolbarDivider} />

          {/* onMouseDown preventDefault keeps focus (and the current text
              selection) inside the contentEditable while a toolbar button
              is clicked -- without it the editor blurs on mousedown, the
              selection collapses, and document.execCommand has nothing to
              apply the format to. */}
          <div onMouseDown={(e) => e.preventDefault()} style={{ display: "flex", alignItems: "center" }}>
            {FORMATTING_BUTTONS.map((tool) => {
              const active = richText && activeFormats.has(tool.id);
              return (
                <Tooltip key={tool.id} label={richText ? tool.label : `${tool.label} (enable rich text first)`}>
                  <Pressable
                    onPress={() => {
                      if (!richText) return;
                      if (tool.id === "bold") applyFormat("bold");
                      else if (tool.id === "italic") applyFormat("italic");
                      else if (tool.id === "underline") applyFormat("underline");
                      else if (tool.id === "bullet") applyFormat("insertUnorderedList");
                      else if (tool.id === "number") applyFormat("insertOrderedList");
                      else if (tool.id === "link") {
                        // Capture the selection before the URL input steals
                        // focus; applyLink() below restores it.
                        const selection = window.getSelection();
                        savedSelectionRef.current =
                          selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
                        setLinkInputOpen(true);
                        return;
                      }
                      // Re-read actual command state rather than toggling a
                      // single "last clicked" value -- bold/italic/underline
                      // are independent and can all be active at once.
                      syncActiveFormats();
                    }}
                    style={({ hovered }: HoverState) => [
                      styles.toolbarButton,
                      richText && active && { backgroundColor: withAlpha(accentColor, 0.14), borderColor: accentColor },
                      richText && !active && hovered && { backgroundColor: "rgba(255,255,255,0.06)" },
                      !richText && styles.toolbarButtonDisabled,
                    ]}
                  >
                    <Text style={[styles.toolbarGlyph, richText && active && { color: accentColor }, !richText && styles.toolbarGlyphDisabled]}>
                      {tool.glyph}
                    </Text>
                  </Pressable>
                </Tooltip>
              );
            })}
          </div>

          <View style={styles.toolbarDivider} />

          <Tooltip label="Attach files">
            <Pressable
              onPress={handleAttachClick}
              style={({ hovered }: HoverState) => [
                styles.attachButton,
                hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
              ]}
            >
              <ListIcon name="attachment" color={colors.text.secondary} size={18} />
            </Pressable>
          </Tooltip>

          <View style={styles.toolbarDivider} />

          <Tooltip label="Templates">
            <Pressable
              ref={templatesAnchorRef}
              onPress={() => setTemplatesOpen((value) => !value)}
              style={({ hovered }: HoverState) => [
                styles.attachButton,
                (hovered || templatesOpen) && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
              ]}
            >
              <ListIcon name="template" color={colors.text.secondary} size={18} />
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
            {attachments.map(({ file, version }, index) => (
              <View key={`${file.name}-${index}`} style={styles.attachmentChip}>
                <Text style={styles.attachmentChipText} numberOfLines={1}>
                  {file.name}
                </Text>
                <Text style={styles.attachmentChipSize}>{formatFileSize(file.size)}</Text>
                {version > 1 && (
                  <View style={[styles.attachmentVersionBadge, { borderColor: accentColor }]}>
                    <Text style={[styles.attachmentVersionText, { color: accentColor }]}>v{version}</Text>
                  </View>
                )}
                {isCompressibleImage(file) && (
                  <Tooltip label="Shrink this image (resize + re-encode)">
                    <Pressable onPress={() => handleCompressAttachment(index)}>
                      <Text style={[styles.attachmentCompress, { color: accentColor }]}>Shrink</Text>
                    </Pressable>
                  </Tooltip>
                )}
                <Pressable onPress={() => removeAttachment(index)}>
                  <ListIcon name="close" color={colors.text.muted} size={10} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {linkInputOpen && (
          <View style={styles.linkInputRow}>
            <TextInput
              style={styles.linkInput}
              value={linkUrl}
              onChangeText={setLinkUrl}
              onSubmitEditing={applyLink}
              placeholder="https://example.com"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
              autoFocus
            />
            <Pressable onPress={applyLink} style={[styles.linkApply, { backgroundColor: accentColor }]}>
              <Text style={styles.linkApplyText}>Link</Text>
            </Pressable>
            <Pressable onPress={() => { setLinkInputOpen(false); setLinkUrl(""); }}>
              <Text style={styles.linkCancel}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {richText ? (
          <RichTextEditor
            initialHtml={editorSeed.html}
            seedVersion={editorSeed.version}
            placeholder="Write your message..."
            // Keep `body` as a live plain-text mirror so autosave, template
            // saving, and the RT toggle all see what's actually typed.
            onChange={(html) => {
              htmlBodyRef.current = html;
              setBody(htmlToPlainText(html));
            }}
            onSelectionChange={syncActiveFormats}
            style={styles.body as object}
          />
        ) : (
          <TextInput
            style={styles.body}
            value={body}
            onChangeText={setBody}
            placeholder="Write your message..."
            placeholderTextColor={colors.text.muted}
            multiline
            textAlignVertical="top"
          />
        )}
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
          <Pressable
            onPress={handleClose}
            style={({ hovered }: HoverState) => [styles.secondaryButton, hovered && styles.secondaryButtonHover]}
            disabled={sending}
          >
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>

          {/* Send Later: a typed DD/MM/YYYY date plus a native digital-clock
              time input, rather than a single datetime-local field whose
              display format shifts with the browser's locale. Both are
              plain <input>s -- no date-picker dependency. */}
          {sendLaterOpen ? (
            <View style={styles.sendLaterRow}>
              <input
                type="text"
                inputMode="numeric"
                value={sendLaterDateText}
                onChange={(e) => setSendLaterDateText(formatDateAsTyped(e.target.value))}
                placeholder="DD/MM/YYYY"
                maxLength={10}
                style={{
                  background: "transparent",
                  border: `1px solid ${colors.border.subtle}`,
                  borderRadius: 6,
                  color: colors.text.primary,
                  fontFamily: fontFamily.mono,
                  fontSize: 12,
                  padding: "4px 8px",
                  outline: "none",
                  width: 92,
                }}
              />
              <input
                type="time"
                value={sendLaterTimeText}
                onChange={(e) => setSendLaterTimeText(e.target.value)}
                style={{
                  background: "transparent",
                  border: `1px solid ${colors.border.subtle}`,
                  borderRadius: 6,
                  color: colors.text.primary,
                  fontFamily: fontFamily.mono,
                  fontSize: 12,
                  padding: "4px 8px",
                  outline: "none",
                  colorScheme: "dark",
                }}
              />
              <Pressable
                onPress={() => sendLaterAt ? handleSend(new Date(sendLaterAt).toISOString()) : null}
                disabled={sending || !sendLaterAt || new Date(sendLaterAt) <= new Date()}
                style={[
                  styles.sendButton,
                  { backgroundColor: withAlpha(accentColor, 0.16), borderColor: accentColor, shadowColor: accentColor },
                  (sending || !sendLaterAt || (sendLaterAt !== null && new Date(sendLaterAt) <= new Date())) && styles.sendButtonDisabled,
                ]}
              >
                <Text style={[styles.sendButtonText, { color: accentColor }]}>Schedule</Text>
              </Pressable>
              <Pressable
                onPress={() => { setSendLaterOpen(false); setSendLaterDateText(""); setSendLaterTimeText(""); }}
                style={({ hovered }: HoverState) => [styles.secondaryButton, hovered && styles.secondaryButtonHover]}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Tooltip label="Send Later">
                <Pressable
                  onPress={() => setSendLaterOpen(true)}
                  style={({ hovered }: HoverState) => [
                    styles.sendLaterButton,
                    hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
                  ]}
                  disabled={sending}
                >
                  <ListIcon name="schedule" color={colors.text.secondary} size={17} />
                </Pressable>
              </Tooltip>
              <Pressable
                onPress={() => handleSend()}
                disabled={sending}
                style={({ hovered }: HoverState) => [
                  styles.sendButton,
                  { backgroundColor: withAlpha(accentColor, 0.16), borderColor: accentColor, shadowColor: accentColor },
                  hovered && !sending && { backgroundColor: withAlpha(accentColor, 0.26) },
                  sending && styles.sendButtonDisabled,
                ]}
              >
                <Text style={[styles.sendButtonText, { color: accentColor }]}>{sending ? "Queueing..." : "Send"}</Text>
              </Pressable>
            </>
          )}
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
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "transparent",
    marginRight: spacing.sm,
  },
  toolbarGlyph: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.base,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  toolbarButtonDisabled: {
    opacity: 0.35,
  },
  toolbarGlyphDisabled: {
    color: colors.text.muted,
  },
  linkInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  linkInput: {
    flex: 1,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
  },
  linkApply: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
  },
  linkApplyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
  linkCancel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  toolbarDivider: {
    width: 1,
    height: 22,
    backgroundColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  attachButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: "rgba(255,255,255,0.04)",
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
  attachmentChipSize: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.muted,
    marginLeft: spacing.xs,
  },
  attachmentVersionBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
    marginLeft: spacing.xs,
  },
  attachmentVersionText: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    fontWeight: "700",
  },
  attachmentCompress: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "600",
    marginHorizontal: spacing.xs,
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
    alignItems: "center",
  },
  fromPicker: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  fromPickerText: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginRight: spacing.xs,
  },
  fromPickerSubtext: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  accountDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  sendLaterButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: "rgba(255,255,255,0.04)",
    marginRight: spacing.sm,
  },
  sendLaterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  secondaryButton: {
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "transparent",
    marginRight: spacing.sm,
  },
  secondaryButtonHover: {
    borderColor: colors.border.subtle,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.base,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  sendButton: {
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.pill,
    borderWidth: 1,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  sendButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.base,
    fontWeight: "700",
    letterSpacing: 0.2,
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
  wkdStatus: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  wkdStatusText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.text.muted,
    marginBottom: 2,
  },
});
