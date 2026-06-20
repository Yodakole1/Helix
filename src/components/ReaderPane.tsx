import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SampleMessage } from "../data/messages";
import { formatMessageTime, getAttachment, getBody } from "../data/messages";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { FolderIcon } from "./FolderIcon";
import { ListIcon } from "./ListIcon";

interface ReaderPaneProps {
  accent: Accent;
  message: SampleMessage | undefined;
  avatarIndex: number;
  // Present only when rendered in the mobile single-pane view-stack.
  onBack?: () => void;
  onReply: (message: SampleMessage) => void;
  onToggleStar: (id: number) => void;
  onArchive: (id: number) => void;
  onMoveToSpam: (id: number) => void;
  onDelete: (id: number) => void;
  onMarkUnread: (id: number) => void;
}

export function ReaderPane({
  accent,
  message,
  avatarIndex,
  onBack,
  onReply,
  onToggleStar,
  onArchive,
  onMoveToSpam,
  onDelete,
  onMarkUnread,
}: ReaderPaneProps) {
  const accentColor = colors.accent[accent];

  // A message with poor color/font choices in its own content can be
  // unreadable in the app's dark theme -- this flips just the content
  // area, not the app's own chrome. Resets per message rather than
  // staying sticky, since the problem is per-email, not a reader setting.
  const [lightMode, setLightMode] = useState(false);
  useEffect(() => {
    setLightMode(false);
  }, [message?.id]);

  if (!message) {
    return (
      <View style={[styles.pane, styles.emptyPane]}>
        <Text style={styles.emptyText}>No email open</Text>
      </View>
    );
  }

  const avatarColor = colorForIndex(avatarIndex);
  const attachment = getAttachment(message.id);

  return (
    <View style={styles.pane}>
      <View style={[styles.header, { borderBottomColor: accentColor }]}>
        {onBack && (
          <Pressable onPress={onBack} style={styles.backButton}>
            <Text style={[styles.backText, { color: accentColor }]}>&#8249; Back</Text>
          </Pressable>
        )}
        <Text style={styles.subject}>{message.subject}</Text>

        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => onReply(message)}
            style={[styles.replyButton, { backgroundColor: accentColor, shadowColor: accentColor }]}
          >
            <Text style={styles.replyButtonText}>Reply</Text>
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

        <Text style={[styles.bodyText, lightMode && styles.bodyTextLight]}>{getBody(message.id)}</Text>

        {attachment && (
          <View style={[styles.vaultCard, { borderColor: accentColor }, lightMode && styles.vaultCardLight]}>
            <View style={[styles.vaultLock, { backgroundColor: accentColor }]} />
            <View>
              <Text style={[styles.vaultName, lightMode && styles.bodyTextLight]}>{attachment.name}</Text>
              <Text style={[styles.vaultMeta, lightMode && styles.vaultMetaLight]}>
                {attachment.size} -- encrypted attachment
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
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
  subject: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: spacing.sm,
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
  vaultCard: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.background.surface,
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
});
