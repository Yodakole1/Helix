import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SampleMessage } from "../data/messages";
import { formatMessageTime, getAttachments, getBody, getHtmlBody } from "../data/messages";
import type { RealAttachment } from "../data/messages";
import type { HoverState } from "../lib/pressable";
import { sanitizeHtml } from "../lib/sanitizeHtml";
import { glassPanel } from "../lib/webStyle";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { FolderIcon } from "./FolderIcon";
import { ListIcon } from "./ListIcon";
import { Tooltip } from "./Tooltip";

interface ReaderPaneProps {
  accountId: string;
  accentColor: string;
  message: SampleMessage | undefined;
  folder: string;
  avatarIndex: number;
  blockImages: boolean;
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
  onDownloadAttachment: (uid: number, attachmentIndex: number) => void;
}

export function ReaderPane({
  accountId,
  accentColor,
  message,
  folder,
  avatarIndex,
  blockImages,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onToggleStar,
  onArchive,
  onMoveToSpam,
  onDelete,
  onMarkUnread,
  onDownloadAttachment,
}: ReaderPaneProps) {
  // A message with poor color/font choices in its own content can be
  // unreadable in the app's dark theme -- this flips just the content
  // area, not the app's own chrome. Resets per message rather than
  // staying sticky, since the problem is per-email, not a reader setting.
  const [lightMode, setLightMode] = useState(false);
  // Per-message override for this one open message -- showing images once
  // isn't the same as flipping the Settings default, so it resets per
  // message rather than persisting.
  const [showImagesOverride, setShowImagesOverride] = useState(false);
  useEffect(() => {
    setLightMode(false);
    setShowImagesOverride(false);
  }, [message?.id]);

  // Computed unconditionally (message can be undefined) so the useMemo
  // below always runs in the same order across renders -- the early
  // "no message" return has to come after every hook call, not before.
  // Prefer real data (from fetch_message_body) over the static sample lookup.
  const htmlBody = message ? (message.htmlBody ?? getHtmlBody(message.id)) : undefined;
  // Remote image detection: sample messages use hasRemoteImage; real HTML
  // bodies get checked for <img> tags at sanitise time.
  const imagesBlocked = (message?.hasRemoteImage === true || (!!htmlBody && !!message?.uid)) && blockImages && !showImagesOverride;
  const sanitizedBody = useMemo(
    () => (htmlBody ? sanitizeHtml(htmlBody, { blockRemoteImages: imagesBlocked }) : undefined),
    [htmlBody, imagesBlocked],
  );

  if (!message) {
    return (
      <View style={[styles.pane, styles.emptyPane]}>
        <Text style={styles.emptyText}>No email open</Text>
      </View>
    );
  }

  const avatarColor = colorForIndex(avatarIndex);
  // Real attachments from fetch_message_body; fall back to sample data
  // stubs for the demo messages.
  const realAtts: RealAttachment[] = message.realAttachments ?? [];
  const sampleAtts = realAtts.length === 0 ? getAttachments(message.id) : [];
  const textBody = message.textBody ?? getBody(message.id);

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
              <Text style={styles.pgpBadgeText}>Encrypted</Text>
            </View>
          )}
          {message.pgpSignedBy && (
            <View style={[styles.pgpBadge, message.pgpSignatureValid ? styles.pgpBadgeValid : styles.pgpBadgeInvalid]}>
              <Text style={styles.pgpBadgeText}>
                {message.pgpSignatureValid ? `Signed by ${message.pgpSignedBy}` : "Signature could not be verified"}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => onReply(message)}
            style={[styles.replyButton, { backgroundColor: accentColor, shadowColor: accentColor }]}
          >
            <Text style={styles.replyButtonText}>Reply</Text>
          </Pressable>
          <Pressable onPress={() => onReplyAll(message)} style={styles.secondaryReplyButton}>
            <Text style={styles.secondaryReplyButtonText}>Reply All</Text>
          </Pressable>
          <Pressable onPress={() => onForward(message)} style={styles.secondaryReplyButton}>
            <Text style={styles.secondaryReplyButtonText}>Forward</Text>
          </Pressable>
          <Pressable onPress={() => onToggleStar(message.id)} style={styles.actionButton}>
            <ListIcon
              name="star"
              filled={message.starred}
              color={message.starred ? colors.accent.amber : colors.text.muted}
              size={15}
            />
          </Pressable>
          <Pressable onPress={() => onArchive(message.id)} style={styles.actionButton}>
            <FolderIcon id="archive" color={colors.text.muted} size={15} />
          </Pressable>
          <Pressable onPress={() => onMoveToSpam(message.id)} style={styles.actionButton}>
            <FolderIcon id="spam" color={colors.text.muted} size={15} />
          </Pressable>
          <Pressable onPress={() => onDelete(message.id)} style={styles.actionButton}>
            <FolderIcon id="trash" color={colors.text.muted} size={15} />
          </Pressable>
          <Pressable
            onPress={() => onMarkUnread(message.id)}
            style={[styles.markUnreadPill, { borderColor: accentColor }]}
          >
            <Text style={[styles.markUnreadPillText, { color: accentColor }]}>Mark as unread</Text>
          </Pressable>
        </View>

        {/* Last in the header on purpose -- the hover tooltip below drops
            down from here, so nothing else in the header can sit beneath
            it and get visually collided with. */}
        <View style={styles.metaRow}>
          <Pressable style={styles.senderRow}>
            {({ hovered }: HoverState) => (
              <>
                <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
                  <Text style={styles.avatarText}>{message.sender.charAt(0).toUpperCase()}</Text>
                </View>
                <Text style={styles.sender}>{message.sender}</Text>
                {hovered && (
                  <View style={[styles.senderTooltip, { borderColor: accentColor }]}>
                    <Text style={styles.senderTooltipName}>{message.sender}</Text>
                    <Text style={styles.senderTooltipDetail}>{message.senderEmail}</Text>
                    <Text style={styles.senderTooltipDetail}>To: {message.to}</Text>
                  </View>
                )}
              </>
            )}
          </Pressable>
          <Text style={styles.time}>{formatMessageTime(message.date)}</Text>
        </View>
      </View>

      <View style={[styles.body, lightMode && styles.bodyLight]}>
        <Pressable
          onPress={() => setLightMode((value) => !value)}
          style={[styles.lightModeToggle, { borderColor: accentColor }, lightMode && { backgroundColor: accentColor }]}
        >
          <Text style={[styles.lightModeToggleText, lightMode ? { color: colors.background.base } : { color: accentColor }]}>
            {lightMode ? "Dark mode" : "Light mode"}
          </Text>
        </Pressable>

        {imagesBlocked && (
          <View style={[styles.imageBlocked, lightMode && styles.vaultCardLight]}>
            <Text style={[styles.imageBlockedText, lightMode && styles.bodyTextLight]}>
              Remote image blocked -- loading it would tell the sender you opened this email.
            </Text>
            <Pressable onPress={() => setShowImagesOverride(true)}>
              <Text style={[styles.imageBlockedAction, { color: accentColor }]}>Show images</Text>
            </Pressable>
          </View>
        )}

        {sanitizedBody ? (
          <HtmlMessageBody html={sanitizedBody} lightMode={lightMode} />
        ) : (
          <Text style={[styles.bodyText, lightMode && styles.bodyTextLight]}>{textBody}</Text>
        )}

        {/* Real attachments from fetch_message_body */}
        {realAtts.map((att) => (
          <View
            key={att.index}
            style={[styles.vaultCard, { borderColor: accentColor }, lightMode && styles.vaultCardLight]}
          >
            <View style={[styles.vaultLock, { backgroundColor: accentColor }]} />
            <View style={styles.vaultText}>
              <Text style={[styles.vaultName, lightMode && styles.bodyTextLight]}>{att.name}</Text>
              <Text style={[styles.vaultMeta, lightMode && styles.vaultMetaLight]}>
                {att.contentType ?? "application/octet-stream"} · {formatBytes(att.size)}
              </Text>
            </View>
            {message?.uid !== undefined ? (
              <Pressable
                onPress={() => onDownloadAttachment(message.uid!, att.index)}
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
        ))}
      </View>
    </View>
  );
}

interface HtmlMessageBodyProps {
  html: string;
  lightMode: boolean;
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
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function HtmlMessageBody({ html, lightMode }: HtmlMessageBodyProps) {
  const [height, setHeight] = useState(200);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const doc = `<!doctype html><html><head><meta charset="utf-8" /><style>
    body { margin: 0; padding: 0; overflow: hidden; word-wrap: break-word;
      font-family: ${fontFamily.ui}; font-size: 14px; line-height: 1.5;
      color: ${lightMode ? "#000000" : colors.text.primary}; background: transparent; }
    img { max-width: 100%; }
  </style></head><body>${html}</body></html>`;

  function handleLoad() {
    const body = iframeRef.current?.contentDocument?.body;
    if (body) setHeight(body.scrollHeight);
  }

  return (
    <iframe
      ref={iframeRef}
      title="Message body"
      srcDoc={doc}
      onLoad={handleLoad}
      sandbox="allow-same-origin allow-popups"
      style={{ width: "100%", border: "none", height, display: "block" }}
    />
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
  },
  emptyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
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
    position: "relative",
  },
  senderTooltip: {
    position: "absolute",
    top: "100%",
    left: 0,
    marginTop: spacing.sm,
    minWidth: 220,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    backgroundColor: colors.background.panel,
    zIndex: 30,
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
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },
  avatarText: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.background.base,
  },
  sender: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
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
  },
  actionButton: {
    padding: spacing.xs,
    marginRight: spacing.sm,
  },
  replyButton: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    marginRight: spacing.md,
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  replyButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
  secondaryReplyButton: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  secondaryReplyButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  markUnreadPill: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.pill,
  },
  markUnreadPillText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    fontWeight: "600",
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
  },
  bodyLight: {
    backgroundColor: "#FFFFFF",
  },
  lightModeToggle: {
    alignSelf: "flex-end",
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radii.pill,
    marginBottom: spacing.lg,
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
    color: colors.text.primary,
    marginBottom: spacing.xl,
  },
  bodyTextLight: {
    color: "#000000",
  },
  imageBlocked: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xl,
  },
  imageBlockedText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginRight: spacing.sm,
  },
  imageBlockedAction: {
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
  vaultLock: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    marginRight: spacing.md,
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
    marginLeft: "auto",
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  downloadButtonDisabled: {
    marginLeft: "auto",
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
});
