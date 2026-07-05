import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { InviteInfo } from "../lib/ics";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface InviteCardProps {
  invite: InviteInfo;
  accentColor: string;
  lightMode: boolean;
  onRespond: (response: "accept" | "decline" | "tentative") => Promise<void>;
}

// Converts raw DTSTART/DTEND values from RFC 5545 ("20260701T100000Z" or
// "20260701") to a short readable string. No date library needed -- the
// format is fixed-length and position-based.
function formatIcsDate(raw: string | null): string {
  if (!raw) return "";
  if (raw.includes("T")) {
    // DATE-TIME: YYYYMMDDTHHmmss[Z]
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(9, 11)}:${raw.slice(11, 13)} UTC`;
  }
  // DATE: YYYYMMDD
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

export function InviteCard({ invite, accentColor, lightMode, onRespond }: InviteCardProps) {
  const [responding, setResponding] = useState<"accept" | "decline" | "tentative" | null>(null);
  const [responded, setResponded] = useState<"accept" | "decline" | "tentative" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRespond(response: "accept" | "decline" | "tentative") {
    setResponding(response);
    setError(null);
    try {
      await onRespond(response);
      setResponded(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send response.");
    } finally {
      setResponding(null);
    }
  }

  const start = formatIcsDate(invite.start);
  const end = formatIcsDate(invite.end);
  const timeRange = start && end && start !== end ? `${start} – ${end}` : start || end || "";

  return (
    <View style={[styles.card, { borderColor: accentColor }, lightMode && styles.cardLight]}>
      <View style={[styles.stripe, { backgroundColor: accentColor }]} />
      <View style={styles.content}>
        <Text style={[styles.chipLabel, lightMode && styles.textLight]}>Meeting invite</Text>
        {invite.summary && (
          <Text style={[styles.summary, lightMode && styles.summaryLight]}>{invite.summary}</Text>
        )}
        {timeRange !== "" && (
          <Text style={[styles.meta, lightMode && styles.metaLight]}>{timeRange}</Text>
        )}
        {invite.location && (
          <Text style={[styles.meta, lightMode && styles.metaLight]}>{invite.location}</Text>
        )}
        {invite.organizer && (
          <Text style={[styles.meta, lightMode && styles.metaLight]}>Organizer: {invite.organizer}</Text>
        )}

        {responded ? (
          <Text style={[styles.respondedLabel, { color: accentColor }]}>
            {responded === "accept"
              ? "Accepted"
              : responded === "decline"
                ? "Declined"
                : "Tentatively accepted"}
          </Text>
        ) : (
          <View style={styles.actions}>
            {(["accept", "decline", "tentative"] as const).map((r) => (
              <Pressable
                key={r}
                onPress={() => handleRespond(r)}
                disabled={responding !== null}
                style={({ hovered }: HoverState) => [
                  styles.responseBtn,
                  r === "accept" && { backgroundColor: accentColor, borderColor: accentColor },
                  r !== "accept" && { borderColor: accentColor },
                  hovered && r !== "accept" && { backgroundColor: withAlpha(accentColor, 0.12) },
                  responding === r && styles.responseBtnBusy,
                ]}
              >
                <Text
                  style={[
                    styles.responseBtnText,
                    r === "accept" ? { color: colors.background.base } : { color: accentColor },
                  ]}
                >
                  {responding === r
                    ? "Sending..."
                    : r === "accept"
                      ? "Accept"
                      : r === "decline"
                        ? "Decline"
                        : "Tentative"}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.md,
    overflow: "hidden",
  },
  cardLight: {
    backgroundColor: "#EEF2FF",
  },
  stripe: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: spacing.md,
  },
  chipLabel: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "700",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  textLight: {
    color: "#666666",
  },
  summary: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 4,
  },
  summaryLight: {
    color: "#000000",
  },
  meta: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  metaLight: {
    color: "#444444",
  },
  actions: {
    flexDirection: "row",
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  responseBtn: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  responseBtnBusy: {
    opacity: 0.6,
  },
  responseBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  respondedLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    marginTop: spacing.md,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginTop: spacing.xs,
  },
});
