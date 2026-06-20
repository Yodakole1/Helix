import { Pressable, StyleSheet, Text, View } from "react-native";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, spacing } from "../theme";

export interface SampleMessage {
  id: number;
  sender: string;
  subject: string;
  preview: string;
  time: string;
  unread: boolean;
}

// Illustrative content for the layout preview only -- there's no account
// sync yet, so none of this is real mail. Swap for live data once IMAP
// fetch lands.
export const SAMPLE_MESSAGES: SampleMessage[] = [
  {
    id: 1,
    sender: "Helix Team",
    subject: "Welcome to Helix",
    preview: "Thanks for trying the early build. Here's what's already working.",
    time: "09:14",
    unread: true,
  },
  {
    id: 2,
    sender: "Maya Chen",
    subject: "Re: Q3 roadmap",
    preview: "Looks good, one comment on the timeline for the encryption work.",
    time: "08:52",
    unread: true,
  },
  {
    id: 3,
    sender: "GitHub",
    subject: "[helix] New issue opened",
    preview: "Issue #42: add OAuth support for Gmail and Outlook accounts.",
    time: "Yesterday",
    unread: false,
  },
  {
    id: 4,
    sender: "Daniel Kim",
    subject: "Server migration notes",
    preview: "Sending over the IMAP server config we discussed on the call.",
    time: "Yesterday",
    unread: false,
  },
  {
    id: 5,
    sender: "Helix Team",
    subject: "Your security keys are ready",
    preview: "Your PGP keypair has been generated and stored in your keychain.",
    time: "Mon",
    unread: false,
  },
];

interface MessageListProps {
  accent: Accent;
  selectedId: number;
  onSelect: (id: number) => void;
  compact: boolean;
}

export function MessageList({ accent, selectedId, onSelect, compact }: MessageListProps) {
  const accentColor = colors.accent[accent];

  return (
    <View style={styles.pane}>
      <View style={styles.header}>
        <Text style={styles.title}>Inbox</Text>
      </View>
      <View>
        {SAMPLE_MESSAGES.map((message, index) => {
          const selected = message.id === selectedId;
          const avatarColor = colorForIndex(index);
          return (
            <Pressable
              key={message.id}
              onPress={() => onSelect(message.id)}
              style={({ hovered }: HoverState) => [
                styles.row,
                compact && styles.rowCompact,
                selected && { backgroundColor: colors.background.panel, borderLeftColor: accentColor },
                !selected && hovered && { backgroundColor: colors.background.panel },
              ]}
            >
              <View style={[styles.avatar, compact && styles.avatarCompact, { backgroundColor: avatarColor }]}>
                <Text style={styles.avatarText}>{message.sender.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowContent}>
                <View style={styles.rowTop}>
                  <View style={styles.senderGroup}>
                    {message.unread && <View style={[styles.unreadDot, { backgroundColor: accentColor }]} />}
                    <Text style={[styles.sender, message.unread && styles.senderUnread]}>{message.sender}</Text>
                  </View>
                  <Text style={styles.time}>{message.time}</Text>
                </View>
                <Text style={[styles.subject, message.unread && styles.subjectUnread]}>{message.subject}</Text>
                {!compact && (
                  <Text style={styles.preview} numberOfLines={1}>
                    {message.preview}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const paneGlass = glassPanel(colors.background.surface, 0.4, 24);

const styles = StyleSheet.create({
  pane: {
    width: 360,
    height: "100%",
    ...paneGlass,
    borderRightWidth: 1,
    borderRightColor: colors.border.strong,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  row: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
  },
  rowCompact: {
    paddingVertical: spacing.xs,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  avatarCompact: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginRight: spacing.sm,
  },
  avatarText: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  rowContent: {
    flex: 1,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  senderGroup: {
    flexDirection: "row",
    alignItems: "center",
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: spacing.xs,
  },
  sender: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  senderUnread: {
    fontWeight: "600",
    color: colors.text.primary,
  },
  time: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  subject: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  subjectUnread: {
    fontWeight: "600",
    color: colors.text.primary,
  },
  preview: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
});
