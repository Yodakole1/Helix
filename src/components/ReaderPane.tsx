import { useEffect, useMemo, useRef, useState } from "react";
import type { InviteInfo } from "../lib/ics";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { SampleMessage } from "../data/messages";
import { formatMessageTime } from "../data/messages";
import { formatClockTime } from "../lib/timeFormat";
import type { RealAttachment } from "../data/messages";
import { useAnchorRect } from "../hooks/useAnchorRect";
import type { HoverState } from "../lib/pressable";
import { sanitizeHtml } from "../lib/sanitizeHtml";
import { glassPanel } from "../lib/webStyle";
import { colorForIndex, colors, fontFamily, fontSize, isLightTheme, radii, spacing, withAlpha } from "../theme";
import { FloatingPortal } from "./FloatingPortal";
import { FolderIcon } from "./FolderIcon";
import { InviteCard } from "./InviteCard";
import { ListIcon } from "./ListIcon";
import { Tooltip } from "./Tooltip";

interface ReaderPaneProps {
  accountId: string;
  accentColor: string;
  message: SampleMessage | undefined;
  folder: string;
  avatarIndex: number;
  blockImages: boolean;
  readReceipts: boolean;
  allowedImageDomains: string[];
  onAllowImageDomain: (domain: string) => void;
  isMuted: boolean;
  // True when the current folder is Spam/Junk -- shows the "Not spam" banner.
  isSpamFolder?: boolean;
  // True when the current folder is the Archive -- the Archive button then
  // reads "Unarchive" and onArchive moves the message back to the inbox.
  isArchiveFolder?: boolean;
  // Present only when rendered in the mobile single-pane view-stack.
  onBack?: () => void;
  onReply: (message: SampleMessage) => void;
  onReplyAll: (message: SampleMessage) => void;
  onForward: (message: SampleMessage) => void;
  onToggleStar: (id: number) => void;
  onArchive: (id: number) => void;
  onMoveToSpam: (id: number) => void;
  onDelete: (id: number) => void;
  onMarkUnread: (id: number) => void;
  // Moves back to inbox + trains the Bayesian classifier as ham.
  onNotSpam?: (id: number) => void;
  // Called with an ISO 8601 snooze-until timestamp chosen by the user.
  onSnooze?: (id: number, until: string) => void;
  onDownloadAttachment: (uid: number, attachmentIndex: number) => void;
  // Opens the attachment for viewing (in-app for images, OS default app
  // otherwise) without saving a copy to Downloads.
  onOpenAttachment?: (uid: number, attachmentIndex: number) => void;
  onMuteThread?: (messageId: string, muted: boolean) => void;
  // Returns raw RFC 822 bytes as base64. Undefined for POP3 and sample
  // messages that have no real IMAP UID -- hides source/EML actions.
  onFetchSource?: () => Promise<string>;
  // Fetches and parses a text/calendar attachment into structured invite data.
  // Undefined when no real UID is available (POP3, sample).
  onFetchInvite?: (uidOrNumber: number, attachmentIndex: number) => Promise<InviteInfo>;
  onRespondToInvite?: (invite: InviteInfo, response: "accept" | "decline" | "tentative") => Promise<void>;
  // Called when the user agrees to send a read receipt for this message.
  onSendMdn?: (notifyAddress: string, messageId: string, subject: string) => void;
}

export function ReaderPane({
  accountId,
  accentColor,
  message,
  folder,
  avatarIndex,
  blockImages,
  readReceipts,
  allowedImageDomains,
  onAllowImageDomain,
  isMuted,
  isSpamFolder,
  isArchiveFolder,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onToggleStar,
  onArchive,
  onMoveToSpam,
  onDelete,
  onMarkUnread,
  onNotSpam,
  onSnooze,
  onDownloadAttachment,
  onOpenAttachment,
  onMuteThread,
  onFetchSource,
  onFetchInvite,
  onRespondToInvite,
  onSendMdn,
}: ReaderPaneProps) {
  // Per-message override for this one open message -- showing images once
  // isn't the same as flipping the Settings default, so it resets per
  // message rather than persisting.
  const [showImagesOverride, setShowImagesOverride] = useState(false);
  // Whether the "Show images" choice picker (Just this time / Always from domain)
  // is expanded. Reset per message alongside showImagesOverride.
  const [showImagesPicker, setShowImagesPicker] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowAnchorRef, overflowAnchorRect] = useAnchorRect(overflowOpen);
  const [senderTooltipOpen, setSenderTooltipOpen] = useState(false);
  const [senderAnchorRef, senderAnchorRect] = useAnchorRect(senderTooltipOpen);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeAnchorRef, snoozeAnchorRect] = useAnchorRect(snoozeOpen);
  const [snoozeCustom, setSnoozeCustom] = useState("");
  // Raw source state -- base64 string from fetch_message_source, cached so
  // clicking View source twice doesn't re-fetch, reset when the message changes.
  const [sourceBase64, setSourceBase64] = useState<string | null>(null);
  const [sourceFetching, setSourceFetching] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  // Tracks whether the user has already sent (or dismissed) the MDN for this message.
  const [mdnSent, setMdnSent] = useState<"sent" | "dismissed" | null>(null);
  // Parsed ICS invite data, keyed by attachment index. "loading" while
  // fetch_message_source is in flight; InviteInfo once parsed; "error" on failure.
  const [invitesByIndex, setInvitesByIndex] = useState<Record<number, InviteInfo | "loading" | "error">>({});
  // Prevents double-fetching calendar attachments when the component re-renders.
  const fetchedInviteIndexes = useRef<Set<number>>(new Set());

  useEffect(() => {
    setShowImagesOverride(false);
    setShowImagesPicker(false);
    setOverflowOpen(false);
    setSnoozeOpen(false);
    setSnoozeCustom("");
    setSourceBase64(null);
    setSourceFetching(false);
    setSourceOpen(false);
    setInvitesByIndex({});
    fetchedInviteIndexes.current.clear();
    setMdnSent(null);
  }, [message?.id]);

  // Eagerly fetch and parse any text/calendar attachments when the body
  // loads. Calendar files are small, so fetching up-front is safe -- the
  // user doesn't have to click Download first to see the invite card.
  useEffect(() => {
    if (!message?.bodyLoaded || !onFetchInvite) return;
    const calendarAtts = (message.realAttachments ?? []).filter(
      (att) => att.contentType === "text/calendar",
    );
    if (calendarAtts.length === 0) return;
    const uidOrNumber = message.uid ?? message.pop3Number;
    if (uidOrNumber === undefined) return;
    for (const att of calendarAtts) {
      if (fetchedInviteIndexes.current.has(att.index)) continue;
      fetchedInviteIndexes.current.add(att.index);
      setInvitesByIndex((prev) => ({ ...prev, [att.index]: "loading" }));
      onFetchInvite(uidOrNumber, att.index)
        .then((info) => setInvitesByIndex((prev) => ({ ...prev, [att.index]: info })))
        .catch(() => setInvitesByIndex((prev) => ({ ...prev, [att.index]: "error" })));
    }
  }, [message?.bodyLoaded, message?.id]);

  // Must be computed unconditionally (message can be undefined) so useMemo
  // always runs in the same hook order -- the early "no message" return
  // comes after all hook calls, not before.
  const htmlBody = message?.htmlBody;
  const senderDomain = message?.senderEmail?.split("@")[1]?.toLowerCase() ?? "";
  const domainAllowed = !!senderDomain && allowedImageDomains.includes(senderDomain);
  // Whether to run sanitization in image-blocking mode. Checks the per-message
  // override and the persistent per-domain whitelist before consulting the
  // global blockImages setting.
  const imagesBlocked = !!htmlBody && blockImages && !showImagesOverride && !domainAllowed;
  const sanitizedBody = useMemo(
    () => (htmlBody ? sanitizeHtml(htmlBody, { blockRemoteImages: imagesBlocked }) : undefined),
    [htmlBody, imagesBlocked],
  );
  // Only show the "images blocked" banner when sanitization actually moved
  // remote image srcs to data-blocked-src. An HTML email with no remote
  // images should open silently with no banner -- the common case.
  const hasActualRemoteImages = imagesBlocked && !!sanitizedBody && sanitizedBody.includes('data-blocked-src="');

  if (!message) {
    return (
      <View style={[styles.pane, styles.emptyPane]}>
        <View style={styles.emptyIcon}>
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" style={{ color: colors.border.subtle }}>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <polyline points="2 5 12 13 22 5" />
          </svg>
        </View>
        <Text style={styles.emptyHeadline}>Select a message</Text>
        <Text style={styles.emptyText}>Choose an email from the list to read it here.</Text>
      </View>
    );
  }

  const avatarColor = colorForIndex(avatarIndex);
  const realAtts: RealAttachment[] = message.realAttachments ?? [];
  const textBody = message.textBody;

  // Shows the raw RFC 822 source in the panel below the message body.
  // Fetches once and caches in sourceBase64 so subsequent opens are instant.
  async function handleViewSource() {
    setOverflowOpen(false);
    setSourceOpen(true);
    if (sourceBase64 !== null || sourceFetching) return;
    setSourceFetching(true);
    try {
      const b64 = await onFetchSource!();
      setSourceBase64(b64);
    } catch (e) {
      setSourceBase64(""); // empty signals a failed fetch
      console.warn("fetch_message_source failed:", e);
    } finally {
      setSourceFetching(false);
    }
  }

  // Downloads the raw RFC 822 bytes as a .eml file (same bytes as View source,
  // different action). RFC 822 bytes *are* a valid .eml file with no wrapping.
  async function handleExportEml() {
    setOverflowOpen(false);
    try {
      const b64 = sourceBase64 !== null ? sourceBase64 : await onFetchSource!();
      if (b64 === "") return;
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: "message/rfc822" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(message!.subject || "message").replace(/[/\\?%*:|"<>]/g, "_")}.eml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn("EML export failed:", e);
    }
  }

  // Snooze preset times. Computed fresh each render so times stay relative to now.
  function snoozePresets(): Array<{ label: string; sublabel: string; iso: string }> {
    const now = new Date();
    const presets: Array<{ label: string; sublabel: string; iso: string }> = [];
    const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    if (later.getDate() === now.getDate()) {
      presets.push({ label: "Later today", sublabel: formatClockTime(later), iso: later.toISOString() });
    }
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
    presets.push({ label: "Tomorrow morning", sublabel: `${tomorrow.toLocaleDateString([], { weekday: "short" })} 08:00`, iso: tomorrow.toISOString() });
    const dayOfWeek = now.getDay();
    if (dayOfWeek < 6) {
      const sat = new Date(now); sat.setDate(sat.getDate() + (6 - dayOfWeek)); sat.setHours(8, 0, 0, 0);
      presets.push({ label: "This weekend", sublabel: "Sat 08:00", iso: sat.toISOString() });
    }
    const daysToMon = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
    const mon = new Date(now); mon.setDate(mon.getDate() + daysToMon); mon.setHours(8, 0, 0, 0);
    presets.push({ label: "Next week", sublabel: "Mon 08:00", iso: mon.toISOString() });
    return presets;
  }

  // Triggers the OS print dialog for the open message -- the standard
  // "Print" every desktop mail client has. The document is staged in a
  // hidden same-page iframe rather than window.open(): the Tauri shell
  // (WebKitGTK on Linux) intercepts window.open and never yields a
  // printable window, while an in-document iframe prints reliably in both
  // the desktop app and browser dev mode. Reuses the already-sanitized
  // HTML body when there is one (safe to inject, DOMPurify ran over it);
  // otherwise the plain-text body is HTML-escaped so a message that
  // happens to contain markup can't inject into the print document.
  function handlePrint() {
    const bodyHtml = sanitizedBody ?? `<pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(textBody ?? "")}</pre>`;
    const doc =
      `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(message!.subject)}</title>` +
      `<style>body{font-family:sans-serif;color:#000;margin:32px;line-height:1.5}` +
      `h1{font-size:18px;margin:0 0 12px}.meta{font-size:13px;color:#444;margin-bottom:16px}` +
      `hr{border:none;border-top:1px solid #ccc;margin:16px 0}img{max-width:100%}</style></head><body>` +
      `<h1>${escapeHtml(message!.subject)}</h1>` +
      `<div class="meta"><strong>From:</strong> ${escapeHtml(message!.sender)} &lt;${escapeHtml(message!.senderEmail)}&gt;<br />` +
      `<strong>Date:</strong> ${escapeHtml(formatMessageTime(message!.date))}</div><hr />${bodyHtml}</body></html>`;

    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "none";
    document.body.appendChild(frame);
    const frameDoc = frame.contentDocument;
    if (!frameDoc) {
      frame.remove();
      return;
    }
    frameDoc.open();
    frameDoc.write(doc);
    frameDoc.close();
    // Give the iframe a beat to lay out (images/styles) before printing;
    // removing it immediately after print returns cancels the dialog on
    // some engines, so it lingers briefly instead.
    window.setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      window.setTimeout(() => frame.remove(), 60_000);
    }, 150);
  }

  return (
    <View style={styles.pane}>
      <View style={[styles.header, { borderBottomColor: accentColor }]}>
        {onBack && (
          <Pressable onPress={onBack} style={styles.backButton}>
            <Text style={[styles.backText, { color: accentColor }]}>&#8249; Back</Text>
          </Pressable>
        )}
        <View style={styles.subjectRow}>
          <Text style={styles.subject}>{message.subject}</Text>
          {message.encrypted && (
            <View style={[styles.pgpBadge, styles.pgpBadgeEncrypted]}>
              <Text style={styles.pgpBadgeText}>PGP Encrypted</Text>
            </View>
          )}
          {message.pgpSignedBy && (
            <View style={[styles.pgpBadge, message.pgpSignatureValid ? styles.pgpBadgeValid : styles.pgpBadgeInvalid]}>
              <Text style={styles.pgpBadgeText}>
                {message.pgpSignatureValid ? `PGP Signed · ${message.pgpSignedBy}` : "PGP Signature Invalid"}
              </Text>
            </View>
          )}
          {message.smimeEncrypted && (
            <View style={[styles.pgpBadge, styles.pgpBadgeEncrypted]}>
              <Text style={styles.pgpBadgeText}>S/MIME Encrypted</Text>
            </View>
          )}
          {message.smimeSigned && (
            <View style={[styles.pgpBadge, message.smimeVerified ? styles.pgpBadgeValid : styles.pgpBadgeInvalid]}>
              <Text style={styles.pgpBadgeText}>
                {message.smimeVerified
                  ? `S/MIME Signed${message.smimeSignerEmail ? ` · ${message.smimeSignerEmail}` : ""}`
                  : "S/MIME Signature Invalid"}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.actionsRow}>
          {/* ── Reply group ── */}
          <Pressable
            onPress={() => onReply(message)}
            style={[styles.primaryBtn, { backgroundColor: accentColor, shadowColor: accentColor }]}
          >
            <ListIcon name="reply" size={15} color={colors.background.base} />
            <Text style={styles.primaryBtnText}>Reply</Text>
          </Pressable>
          <Pressable
            onPress={() => onReplyAll(message)}
            style={({ hovered }: HoverState) => [
              styles.ghostBtn,
              hovered && { backgroundColor: withAlpha(accentColor, 0.12), borderColor: accentColor },
            ]}
          >
            {({ hovered }: HoverState) => (
              <>
                <ListIcon name="reply-all" size={14} color={hovered ? colors.text.primary : colors.text.secondary} />
                <Text style={[styles.ghostBtnText, hovered && { color: colors.text.primary }]}>Reply All</Text>
              </>
            )}
          </Pressable>
          <Pressable
            onPress={() => onForward(message)}
            style={({ hovered }: HoverState) => [
              styles.ghostBtn,
              hovered && { backgroundColor: withAlpha(accentColor, 0.12), borderColor: accentColor },
            ]}
          >
            {({ hovered }: HoverState) => (
              <>
                <ListIcon name="forward" size={14} color={hovered ? colors.text.primary : colors.text.secondary} />
                <Text style={[styles.ghostBtnText, hovered && { color: colors.text.primary }]}>Forward</Text>
              </>
            )}
          </Pressable>

          <View style={styles.actionSep} />

          {/* ── Management group ── */}
          <Tooltip label={message.starred ? "Unstar" : "Star"}>
            <Pressable
              onPress={() => onToggleStar(message.id)}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                (hovered || message.starred) && { backgroundColor: withAlpha(colors.accent.amber, 0.15) },
              ]}
            >
              {({ hovered }: HoverState) => (
                <ListIcon
                  name="star"
                  filled={message.starred}
                  size={18}
                  color={message.starred || hovered ? colors.accent.amber : colors.text.muted}
                />
              )}
            </Pressable>
          </Tooltip>
          <Tooltip label={isArchiveFolder ? "Unarchive — move back to Inbox" : "Archive"}>
            <Pressable
              onPress={() => onArchive(message.id)}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
              ]}
            >
              {({ hovered }: HoverState) => (
                <FolderIcon
                  id={isArchiveFolder ? "inbox" : "archive"}
                  size={18}
                  color={hovered ? accentColor : colors.text.muted}
                />
              )}
            </Pressable>
          </Tooltip>
          <Tooltip label="Spam">
            <Pressable
              onPress={() => onMoveToSpam(message.id)}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                hovered && { backgroundColor: withAlpha(colors.accent.amber, 0.12) },
              ]}
            >
              {({ hovered }: HoverState) => (
                <FolderIcon id="spam" size={18} color={hovered ? colors.accent.amber : colors.text.muted} />
              )}
            </Pressable>
          </Tooltip>
          <Tooltip label="Delete">
            <Pressable
              onPress={() => onDelete(message.id)}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                hovered && { backgroundColor: "rgba(239, 68, 68, 0.12)" },
              ]}
            >
              {({ hovered }: HoverState) => (
                <FolderIcon id="trash" size={18} color={hovered ? "#EF4444" : colors.text.muted} />
              )}
            </Pressable>
          </Tooltip>

          <View style={styles.actionSep} />

          {/* ── Utility group ── */}
          {onSnooze && (
            <Tooltip label="Snooze">
              <Pressable
                ref={snoozeAnchorRef}
                onPress={() => { setSnoozeOpen((v) => !v); setOverflowOpen(false); }}
                style={({ hovered }: HoverState) => [
                  styles.iconBtn,
                  (hovered || snoozeOpen) && { backgroundColor: withAlpha(accentColor, 0.15) },
                ]}
              >
                <ListIcon name="schedule" size={18} color={snoozeOpen ? accentColor : colors.text.muted} />
              </Pressable>
            </Tooltip>
          )}
          <Tooltip label="Mark as unread">
            <Pressable
              onPress={() => onMarkUnread(message.id)}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
              ]}
            >
              {({ hovered }: HoverState) => (
                <ListIcon name="mail" size={18} color={hovered ? accentColor : colors.text.muted} />
              )}
            </Pressable>
          </Tooltip>
          <Tooltip label="Print">
            <Pressable
              onPress={handlePrint}
              style={({ hovered }: HoverState) => [
                styles.iconBtn,
                hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
              ]}
            >
              {({ hovered }: HoverState) => (
                <ListIcon name="print" size={18} color={hovered ? accentColor : colors.text.muted} />
              )}
            </Pressable>
          </Tooltip>
          {(onFetchSource || (message?.messageId && onMuteThread)) && (
            <Tooltip label="More actions">
              <Pressable
                ref={overflowAnchorRef}
                onPress={() => setOverflowOpen((v) => !v)}
                style={({ hovered }: HoverState) => [
                  styles.iconBtn,
                  (hovered || overflowOpen) && { backgroundColor: withAlpha(accentColor, 0.15) },
                ]}
              >
                <ListIcon name="ellipsis" size={18} color={overflowOpen ? accentColor : colors.text.muted} />
              </Pressable>
            </Tooltip>
          )}
        </View>
        {overflowOpen && overflowAnchorRect && (
          <FloatingPortal
            top={overflowAnchorRect.bottom + 6}
            left={overflowAnchorRect.right - 160}
            onDismiss={() => setOverflowOpen(false)}
          >
            <View style={styles.overflowMenu}>
              {onFetchSource && (
                <Pressable
                  onPress={handleViewSource}
                  style={({ hovered }: HoverState) => [styles.overflowItem, hovered && styles.overflowItemHover]}
                >
                  <Text style={styles.overflowItemText}>View source</Text>
                </Pressable>
              )}
              {onFetchSource && (
                <Pressable
                  onPress={handleExportEml}
                  style={({ hovered }: HoverState) => [styles.overflowItem, hovered && styles.overflowItemHover]}
                >
                  <Text style={styles.overflowItemText}>Export .eml</Text>
                </Pressable>
              )}
              {message?.messageId && onMuteThread && (
                <Pressable
                  onPress={() => {
                    onMuteThread(message.messageId!, !isMuted);
                    setOverflowOpen(false);
                  }}
                  style={({ hovered }: HoverState) => [styles.overflowItem, hovered && styles.overflowItemHover]}
                >
                  <Text style={[styles.overflowItemText, isMuted && { color: accentColor }]}>
                    {isMuted ? "Unmute thread" : "Mute thread"}
                  </Text>
                </Pressable>
              )}
            </View>
          </FloatingPortal>
        )}

        {snoozeOpen && snoozeAnchorRect && (
          <FloatingPortal
            top={snoozeAnchorRect.bottom + 6}
            left={snoozeAnchorRect.left - 10}
            onDismiss={() => setSnoozeOpen(false)}
          >
            <View style={styles.snoozePicker}>
              <Text style={styles.snoozePickerTitle}>Snooze until...</Text>
              {snoozePresets().map((preset) => (
                <Pressable
                  key={preset.iso}
                  onPress={() => { onSnooze!(message.id, preset.iso); setSnoozeOpen(false); }}
                  style={({ hovered }: HoverState) => [styles.snoozeOption, hovered && styles.snoozeOptionHover]}
                >
                  <Text style={styles.snoozeOptionLabel}>{preset.label}</Text>
                  <Text style={styles.snoozeOptionTime}>{preset.sublabel}</Text>
                </Pressable>
              ))}
              <View style={styles.snoozeCustomRow}>
                <input
                  type="datetime-local"
                  value={snoozeCustom}
                  onChange={(e) => setSnoozeCustom((e.target as HTMLInputElement).value)}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: `1px solid ${colors.border.subtle}`,
                    borderRadius: radii.sm,
                    color: colors.text.secondary,
                    fontFamily: fontFamily.ui,
                    fontSize: 12,
                    padding: "4px 8px",
                    colorScheme: isLightTheme ? "light" : "dark",
                    outline: "none",
                  }}
                />
                <Pressable
                  onPress={() => {
                    if (!snoozeCustom) return;
                    onSnooze!(message.id, new Date(snoozeCustom).toISOString());
                    setSnoozeOpen(false);
                    setSnoozeCustom("");
                  }}
                  style={[styles.snoozeSetBtn, { backgroundColor: accentColor }]}
                >
                  <Text style={styles.snoozeSetBtnText}>Set</Text>
                </Pressable>
              </View>
            </View>
          </FloatingPortal>
        )}

        <View style={styles.metaRow}>
          <Pressable
            ref={senderAnchorRef}
            style={styles.senderRow}
            onHoverIn={() => setSenderTooltipOpen(true)}
            onHoverOut={() => setSenderTooltipOpen(false)}
          >
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>{(message.sender || "?").charAt(0).toUpperCase()}</Text>
            </View>
            <Text style={styles.sender}>{message.sender}</Text>
          </Pressable>
          {senderTooltipOpen && senderAnchorRect && (
            // Rendered through FloatingPortal (mounted at document.body) rather
            // than an in-place `position: absolute` node -- every react-native-web
            // View is its own CSS stacking context, so a bare zIndex here could
            // never out-rank the message body ScrollView that follows it in the
            // DOM, and the tooltip ended up rendering underneath the body instead
            // of floating over it. Same fix as the overflow menu below.
            <FloatingPortal top={senderAnchorRect.bottom + 6} left={senderAnchorRect.left}>
              <View style={[styles.senderTooltip, { borderColor: accentColor }]}>
                <Text style={styles.senderTooltipName}>{message.sender}</Text>
                <Text style={styles.senderTooltipDetail}>{message.senderEmail}</Text>
                {!!message.to && <Text style={styles.senderTooltipDetail}>To: {message.to}</Text>}
                {!!message.cc && <Text style={styles.senderTooltipDetail}>Cc: {message.cc}</Text>}
              </View>
            </FloatingPortal>
          )}
          <Text style={styles.time}>{formatMessageTime(message.date)}</Text>
        </View>
      </View>

      <ScrollView
        style={[styles.body, styles.bodyLight]}
        contentContainerStyle={styles.bodyContent}
      >
        {isSpamFolder && onNotSpam && (
          <View style={[styles.notSpamBanner, { borderColor: withAlpha(accentColor, 0.3) }]}>
            <Text style={styles.notSpamText}>This message is in Spam.</Text>
            <Pressable
              onPress={() => onNotSpam(message.id)}
              style={({ hovered }: HoverState) => [
                styles.notSpamBtn,
                { borderColor: accentColor },
                hovered && { backgroundColor: withAlpha(accentColor, 0.15) },
              ]}
            >
              <Text style={[styles.notSpamBtnText, { color: accentColor }]}>Not spam — move to Inbox</Text>
            </Pressable>
          </View>
        )}

        {readReceipts &&
          message.dispositionNotificationTo &&
          message.messageId &&
          mdnSent === null &&
          onSendMdn && (
            <View style={[styles.notSpamBanner, { borderColor: withAlpha(accentColor, 0.3) }]}>
              <Text style={styles.notSpamText}>
                The sender requested a read receipt.
              </Text>
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => {
                    onSendMdn(
                      message.dispositionNotificationTo!,
                      message.messageId!,
                      message.subject,
                    );
                    setMdnSent("sent");
                  }}
                  style={({ hovered }: HoverState) => [
                    styles.notSpamBtn,
                    { borderColor: accentColor },
                    hovered && { backgroundColor: withAlpha(accentColor, 0.15) },
                  ]}
                >
                  <Text style={[styles.notSpamBtnText, { color: accentColor }]}>Send receipt</Text>
                </Pressable>
                <Pressable
                  onPress={() => setMdnSent("dismissed")}
                  style={({ hovered }: HoverState) => [
                    styles.notSpamBtn,
                    { borderColor: "rgba(255,255,255,0.2)" },
                    hovered && { backgroundColor: "rgba(255,255,255,0.08)" },
                  ]}
                >
                  <Text style={[styles.notSpamBtnText, { color: "#888" }]}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
          )}

        {mdnSent === "sent" && (
          <View style={styles.mutedBanner}>
            <Text style={styles.mutedBannerText}>Read receipt sent.</Text>
          </View>
        )}

        {isMuted && (
          <View style={styles.mutedBanner}>
            <Text style={styles.mutedBannerText}>
              Thread muted -- new messages won't trigger notifications.
            </Text>
          </View>
        )}

        {sourceOpen && (
          <View style={styles.sourcePanel}>
            <View style={styles.sourcePanelHeader}>
              <Text style={styles.sourcePanelTitle}>Raw message source</Text>
              <Pressable onPress={() => setSourceOpen(false)}>
                <Text style={[styles.sourcePanelClose, { color: accentColor }]}>Close</Text>
              </Pressable>
            </View>
            {sourceFetching ? (
              <Text style={styles.sourcePanelMeta}>Fetching...</Text>
            ) : sourceBase64 === "" ? (
              <Text style={[styles.sourcePanelMeta, { color: colors.accent.amber }]}>
                Could not fetch message source.
              </Text>
            ) : (
              <ScrollView style={styles.sourcePanelScroll} nestedScrollEnabled>
                <Text selectable style={styles.sourcePanelText}>
                  {sourceBase64 !== null
                    ? new TextDecoder("utf-8", { fatal: false }).decode(
                        Uint8Array.from(atob(sourceBase64), (c) => c.charCodeAt(0)),
                      )
                    : ""}
                </Text>
              </ScrollView>
            )}
          </View>
        )}

        {hasActualRemoteImages && (
          <View style={[styles.imageBlocked, { borderColor: withAlpha(accentColor, 0.35) }]}>
            <View style={[styles.imageBlockedIcon, { backgroundColor: withAlpha(accentColor, 0.14) }]}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </View>
            <View style={styles.imageBlockedBody}>
              <Text style={styles.imageBlockedTitle}>Remote images blocked</Text>
              <Text style={styles.imageBlockedText}>
                Loading them can tell the sender when you opened this email.
              </Text>
              {showImagesPicker && (
                <View style={styles.imageBlockedPicker}>
                  <Pressable
                    onPress={() => { setShowImagesOverride(true); setShowImagesPicker(false); }}
                    style={({ hovered }: HoverState) => [
                      styles.imagePickerOption,
                      { borderColor: accentColor },
                      hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
                    ]}
                  >
                    <Text style={[styles.imagePickerOptionText, { color: accentColor }]}>Just this time</Text>
                  </Pressable>
                  {!!senderDomain && (
                    <Pressable
                      onPress={() => { onAllowImageDomain(senderDomain); setShowImagesPicker(false); }}
                      style={({ hovered }: HoverState) => [
                        styles.imagePickerOption,
                        { borderColor: accentColor },
                        hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
                      ]}
                    >
                      <Text style={[styles.imagePickerOptionText, { color: accentColor }]}>
                        Always from {senderDomain}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => setShowImagesPicker(false)} style={styles.imagePickerCancel}>
                    <Text style={[styles.imageBlockedAction, { color: colors.text.muted }]}>Cancel</Text>
                  </Pressable>
                </View>
              )}
            </View>
            {!showImagesPicker && (
              <Pressable
                onPress={() => setShowImagesPicker(true)}
                style={({ hovered }: HoverState) => [
                  styles.imageShowBtn,
                  { borderColor: accentColor },
                  hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
                ]}
              >
                <Text style={[styles.imageBlockedAction, { color: accentColor }]}>Show images</Text>
              </Pressable>
            )}
          </View>
        )}

        {sanitizedBody ? (
          <HtmlMessageBody html={sanitizedBody} blockRemoteImages={imagesBlocked} shielded={overflowOpen} />
        ) : (
          <Text style={styles.bodyText}>
            {textBody?.replace(/\r\n/g, "\n").replace(/\r/g, "\n")}
          </Text>
        )}

        {realAtts.map((att) => {
          // Calendar attachments get an invite card instead of a download chip
          // when we have a UID to fetch with and a response handler is available.
          if (att.contentType === "text/calendar" && onRespondToInvite) {
            const invite = invitesByIndex[att.index];
            if (invite === "loading") {
              return (
                <View key={att.index} style={[styles.vaultCard, { borderColor: accentColor }]}>
                  <Text style={styles.vaultMeta}>Loading invite...</Text>
                </View>
              );
            }
            if (typeof invite === "object") {
              return (
                <InviteCard
                  key={att.index}
                  invite={invite}
                  accentColor={accentColor}
                  lightMode={false}
                  onRespond={(response) => onRespondToInvite(invite, response)}
                />
              );
            }
            // "error" or undefined -- fall through to the plain download card
          }

          const fetchable = message?.uid !== undefined || message?.pop3Number !== undefined;
          const uidOrNumber = (message?.uid ?? message?.pop3Number)!;
          const isImage = (att.contentType ?? "").startsWith("image/");
          const ext = (att.name.includes(".") ? att.name.split(".").pop()! : "").slice(0, 4).toUpperCase();
          return (
          <View
            key={att.index}
            style={[styles.vaultCard, { borderColor: withAlpha(accentColor, 0.4) }]}
          >
            {/* Clicking the badge/name opens the attachment in the in-app
                viewer (or the OS default app) -- no download required. The
                explicit Download button is the only thing that writes to
                the Downloads folder. */}
            <Pressable
              disabled={!fetchable || !onOpenAttachment}
              onPress={() => onOpenAttachment?.(uidOrNumber, att.index)}
              style={styles.attachmentBody}
            >
              <View style={[styles.fileBadge, { backgroundColor: withAlpha(accentColor, 0.13) }]}>
                {isImage ? (
                  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                ) : (
                  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}
                {!!ext && <Text style={[styles.fileBadgeExt, { color: accentColor }]}>{ext}</Text>}
              </View>
              <View style={styles.vaultText}>
                <Text style={styles.vaultName}>{att.name}</Text>
                <Text style={styles.vaultMeta}>
                  {att.contentType ?? "application/octet-stream"} · {formatBytes(att.size)}
                </Text>
              </View>
            </Pressable>
            <View style={styles.attachmentActions}>
              {fetchable && onOpenAttachment ? (
                <Pressable
                  onPress={() => onOpenAttachment(uidOrNumber, att.index)}
                  style={({ hovered }: HoverState) => [
                    styles.downloadButton,
                    { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
                    hovered && { backgroundColor: accentColor },
                  ]}
                >
                  {({ hovered }: HoverState) => (
                    <Text style={[styles.downloadButtonText, { color: accentColor }, hovered && { color: colors.background.base }]}>
                      Open
                    </Text>
                  )}
                </Pressable>
              ) : null}
              {fetchable ? (
                <Pressable
                  onPress={() => onDownloadAttachment(uidOrNumber, att.index)}
                  style={({ hovered }: HoverState) => [
                    styles.downloadButton,
                    { borderColor: accentColor },
                    hovered && { backgroundColor: accentColor },
                  ]}
                >
                  {({ hovered }: HoverState) => (
                    <Text style={[styles.downloadButtonText, hovered && { color: colors.background.base }]}>
                      Download
                    </Text>
                  )}
                </Pressable>
              ) : (
                <View style={styles.downloadButtonDisabled}>
                  <Text style={styles.downloadButtonText}>Download</Text>
                </View>
              )}
            </View>
          </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

interface HtmlMessageBodyProps {
  html: string;
  // When true, the iframe CSP restricts img-src to data: and blob: only,
  // preventing remote tracking pixels from loading.
  blockRemoteImages?: boolean;
  // When true, a transparent cover div is placed over the iframe. This
  // prevents the iframe's compositor layer from visually punching through
  // fixed-position overlays (overflow menu, tooltips) -- a known Chromium
  // and WebKit quirk where iframes can render above z-indexed elements
  // from the parent document.
  shielded?: boolean;
}

// Real mail HTML renders in a sandboxed <iframe>, not a plain div with
// dangerouslySetInnerHTML -- sanitizeHtml() already strips script/style
// tags and event-handler attributes, but the iframe sandbox is a second,
// independent containment layer in case a sanitizer bug ever lets
// something through, and (just as importantly) it keeps any inline CSS in
// the email body scoped to its own document instead of able to affect
// the rest of the app. `allow-same-origin` (without `allow-scripts`) lets
// this component read the iframe's rendered height to size itself --
// scripts stay fully disabled either way. `allow-popups` is needed for
// links (forced to target="_blank" by sanitizeHtml) to actually open.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function HtmlMessageBody({ html, blockRemoteImages = false, shielded = false }: HtmlMessageBodyProps) {
  const [height, setHeight] = useState(200);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const imgSrc = blockRemoteImages ? "data: blob:" : "* data: blob:";
  const doc = `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src *;"><style>
    body { margin: 0; padding: 8px 0; overflow: hidden; word-wrap: break-word;
      font-family: ${fontFamily.ui}; font-size: 14px; line-height: 1.6;
      color: #111111; background: transparent; }
    img { max-width: 100%; height: auto; }
    a { color: #0070c0; }
    pre, code { font-family: monospace; background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
    blockquote { margin: 0 0 0 16px; padding-left: 12px; border-left: 3px solid #ccc; color: #555; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { padding: 4px 8px; }
  </style></head><body>${html}</body></html>`;

  function measure() {
    const body = iframeRef.current?.contentDocument?.body;
    if (body) {
      // Add a small buffer so content doesn't clip on the bottom edge.
      setHeight(body.scrollHeight + 16);
    }
  }

  // The iframe's `load` event only fires after every subresource -- with
  // slow remote images the body would sit collapsed at the default height
  // until the last image finished. Instead the text is sized as soon as
  // the document exists and re-sized as each image lands: a ResizeObserver
  // on the iframe body catches every progressive layout change, with a
  // short polling fallback for engines that don't fire it across the
  // frame boundary.
  useEffect(() => {
    measure();
    let observer: ResizeObserver | null = null;
    const attach = () => {
      const body = iframeRef.current?.contentDocument?.body;
      if (!body || typeof ResizeObserver === "undefined") return false;
      observer = new ResizeObserver(measure);
      observer.observe(body);
      return true;
    };
    attach();
    const poll = setInterval(() => {
      measure();
      if (!observer) attach();
    }, 300);
    const stopPolling = setTimeout(() => clearInterval(poll), 15_000);
    return () => {
      observer?.disconnect();
      clearInterval(poll);
      clearTimeout(stopPolling);
    };
  }, [doc]);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <iframe
        ref={iframeRef}
        title="Message body"
        srcDoc={doc}
        onLoad={measure}
        sandbox="allow-same-origin allow-popups"
        style={{ width: "100%", border: "none", height, display: "block" }}
      />
      {/* Transparent shield stops the iframe's GPU compositor layer from
          visually appearing above fixed-position overlays when a menu is open. */}
      {shielded && (
        <div style={{ position: "absolute", inset: 0, background: "transparent" }} />
      )}
    </div>
  );
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    height: "100%",
    ...glassPanel(colors.background.base, 0.55, 30),
  },
  emptyPane: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyIcon: {
    marginBottom: 4,
    opacity: 0.7,
  },
  emptyHeadline: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  emptyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    textAlign: "center",
    maxWidth: 220,
  },
  header: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
    borderBottomWidth: 1,
  },
  backButton: {
    alignSelf: "flex-start",
    marginBottom: spacing.md,
  },
  backText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  subjectRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    marginBottom: spacing.sm,
  },
  subject: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "600",
    color: colors.text.primary,
    marginRight: spacing.sm,
  },
  pgpBadge: {
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    marginRight: spacing.sm,
    marginTop: 2,
  },
  pgpBadgeEncrypted: {
    backgroundColor: withAlpha(colors.accent.cyan, 0.18),
  },
  pgpBadgeValid: {
    backgroundColor: withAlpha(colors.accent.green, 0.18),
  },
  pgpBadgeInvalid: {
    backgroundColor: withAlpha(colors.accent.amber, 0.18),
  },
  pgpBadgeText: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "700",
    color: colors.text.secondary,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  senderRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  senderTooltip: {
    minWidth: 220,
    maxWidth: 320,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.background.panel,
  },
  senderTooltipName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 4,
  },
  senderTooltipDetail: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },
  avatarText: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  sender: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "500",
    color: colors.text.primary,
  },
  time: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    height: 34,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    gap: 7,
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  primaryBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  ghostBtn: {
    flexDirection: "row",
    alignItems: "center",
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    gap: 6,
  },
  ghostBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  actionSep: {
    width: 1,
    height: 20,
    backgroundColor: colors.border.subtle,
    marginHorizontal: spacing.xs,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  // The reading surface. Pure white in the dark theme (mail content is
  // designed against white); a soft paper tone in light mode so the whole
  // window isn't wall-to-wall bright.
  bodyLight: {
    backgroundColor: isLightTheme ? "#F0EFEA" : "#FFFFFF",
  },
  lightModeToggleText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  bodyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.md,
    lineHeight: 24,
    color: "#111111",
    marginBottom: spacing.xl,
  },
  imageBlocked: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xl,
  },
  imageBlockedIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  imageBlockedBody: {
    flex: 1,
    minWidth: 0,
  },
  imageBlockedTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 1,
  },
  imageBlockedText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  imageBlockedAction: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  imageShowBtn: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radii.pill,
  },
  imageBlockedPicker: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  imagePickerOption: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.pill,
  },
  imagePickerCancel: {
    paddingVertical: 4,
    paddingHorizontal: spacing.xs,
  },
  imagePickerOptionText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  vaultCard: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.md,
  },
  vaultCardLight: {
    backgroundColor: "#F0F0F0",
  },
  attachmentBody: {
    flexDirection: "row",
    alignItems: "center",
  },
  fileBadge: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
    gap: 1,
  },
  fileBadgeExt: {
    fontFamily: fontFamily.mono,
    fontSize: 7,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  attachmentActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginLeft: "auto",
  },
  vaultText: {
    marginRight: spacing.lg,
  },
  vaultName: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginBottom: 2,
  },
  vaultMeta: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  vaultMetaLight: {
    color: "#555555",
  },
  downloadButton: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  downloadButtonDisabled: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    opacity: 0.4,
  },
  downloadButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    fontWeight: "600",
    color: colors.text.muted,
  },
  overflowMenu: {
    minWidth: 160,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
    overflow: "hidden",
  },
  overflowItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  overflowItemHover: {
    backgroundColor: colors.background.surface,
  },
  overflowItemText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  notSpamBanner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.md,
  },
  notSpamText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    flex: 1,
  },
  notSpamBtn: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  notSpamBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  mutedBanner: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.md,
    alignSelf: "flex-start",
  },
  mutedBannerText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  snoozePicker: {
    minWidth: 230,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    paddingVertical: spacing.xs,
    overflow: "hidden",
  },
  snoozePickerTitle: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  snoozeOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  snoozeOptionHover: {
    backgroundColor: colors.background.surface,
  },
  snoozeOptionLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
  },
  snoozeOptionTime: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginLeft: spacing.lg,
  },
  snoozeCustomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
    marginTop: spacing.xs,
  },
  snoozeSetBtn: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
  },
  snoozeSetBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
  sourcePanel: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.lg,
    overflow: "hidden",
  },
  sourcePanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  sourcePanelTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourcePanelClose: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  sourcePanelMeta: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    padding: spacing.md,
  },
  sourcePanelScroll: {
    maxHeight: 360,
  },
  sourcePanelText: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.secondary,
    lineHeight: 18,
    padding: spacing.md,
  },
});
