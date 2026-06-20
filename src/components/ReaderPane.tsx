import { StyleSheet, Text, View } from "react-native";
import { glassPanel } from "../lib/webStyle";
import type { Accent } from "../theme";
import { colorForIndex, colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { SAMPLE_MESSAGES } from "./MessageList";

// Body copy and the attachment shown below are part of the same layout
// preview as the rows in MessageList -- not real synced mail.
const BODY_BY_ID: Record<number, string> = {
  1: "Thanks for trying the early build. The desktop shell and account silos are wired up. Account setup and real IMAP sync are next.",
  2: "Looks good, one comment on the timeline for the encryption work -- can we slot key generation before the OAuth flow instead of after?",
  3: "Issue #42: add OAuth support for Gmail and Outlook accounts. Filed by a contributor, needs triage.",
  4: "Sending over the IMAP server config we discussed on the call. Let me know if port 993 with implicit TLS works on your end.",
  5: "Your PGP keypair has been generated and stored in your OS keychain. The attachment below holds the exported public key.",
};

const ATTACHMENT_BY_ID: Record<number, { name: string; size: string }> = {
  5: { name: "helix-public-key.asc", size: "4 KB" },
};

interface ReaderPaneProps {
  accent: Accent;
  selectedId: number;
}

export function ReaderPane({ accent, selectedId }: ReaderPaneProps) {
  const index = SAMPLE_MESSAGES.findIndex((candidate) => candidate.id === selectedId);
  const message = SAMPLE_MESSAGES[index];
  const accentColor = colors.accent[accent];

  if (!message) {
    return <View style={styles.pane} />;
  }

  const avatarColor = colorForIndex(index);
  const attachment = ATTACHMENT_BY_ID[message.id];

  return (
    <View style={styles.pane}>
      <View style={[styles.header, { borderBottomColor: accentColor }]}>
        <Text style={styles.subject}>{message.subject}</Text>
        <View style={styles.metaRow}>
          <View style={styles.senderRow}>
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>{message.sender.charAt(0).toUpperCase()}</Text>
            </View>
            <Text style={styles.sender}>{message.sender}</Text>
          </View>
          <Text style={styles.time}>{message.time}</Text>
        </View>
      </View>

      <View style={styles.body}>
        <Text style={styles.bodyText}>{BODY_BY_ID[message.id]}</Text>

        {attachment && (
          <View style={[styles.vaultCard, { borderColor: accentColor }]}>
            <View style={[styles.vaultLock, { backgroundColor: accentColor }]} />
            <View>
              <Text style={styles.vaultName}>{attachment.name}</Text>
              <Text style={styles.vaultMeta}>{attachment.size} -- encrypted attachment</Text>
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
  header: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
    borderBottomWidth: 1,
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
  body: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
  },
  bodyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.md,
    lineHeight: 24,
    color: colors.text.primary,
    marginBottom: spacing.xl,
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
});
