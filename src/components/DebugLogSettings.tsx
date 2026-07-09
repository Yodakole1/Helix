import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { clearDebugLog, getDebugLog, type DebugLogEntry } from "../lib/debugLog";
import { usePersistedState } from "../hooks/usePersistedState";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { settingsStyles } from "./settingsStyles";
import { Switch } from "./Switch";

interface DebugLogSettingsProps {
  accentColor: string;
}

// The Settings > About debug section: a Debug mode toggle, with the log
// viewer below it while enabled. Debug mode also reveals the "Send test
// notification" button under Settings > Notifications (read from
// localStorage there at render time, same key). It's a visibility switch,
// not a collection switch -- the in-memory log is always recording either
// way and never leaves this computer.
export function DebugSettings({ accentColor }: DebugLogSettingsProps) {
  const [debugMode, setDebugMode] = usePersistedState("helix:debugMode", 0);

  return (
    <View>
      <Text style={settingsStyles.sectionTitle}>Debug</Text>
      <View style={settingsStyles.settingRow}>
        <View style={settingsStyles.settingInfo}>
          <Text style={settingsStyles.settingLabel}>Debug mode</Text>
          <Text style={settingsStyles.settingDescription}>
            Shows the debug log below, and a "Send test notification" button under Notifications. For
            troubleshooting; everyday use doesn't need it.
          </Text>
        </View>
        <Switch value={debugMode === 1} onChange={() => setDebugMode(debugMode === 1 ? 0 : 1)} color={accentColor} />
      </View>
      {debugMode === 1 && <DebugLogSettings accentColor={accentColor} />}
    </View>
  );
}

type Status = "loading" | "loaded" | "error";

function formatEntry(e: DebugLogEntry): string {
  return `[${e.timestamp}] ${e.source}: ${e.message}`;
}

// Real: src-tauri/src/debug_log.rs's get_debug_log/clear_debug_log. Renders
// the in-memory app-wide activity log (no passwords or tokens, just hosts/
// URLs/outcomes) so a failure like an HTTP 403 or a refused login is
// visible directly rather than only as a paraphrased error message.
function DebugLogSettings({ accentColor }: DebugLogSettingsProps) {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setStatus("loading");
    try {
      const result = await getDebugLog();
      setEntries(result);
      setStatus("loaded");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : typeof err === "string" ? err : "Could not read the debug log.",
      );
      setStatus("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const logText = entries.map(formatEntry).join("\n");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be denied outside a user gesture in some
      // embeds -- the text below stays selectable so copying still works
      // by hand even if this shortcut doesn't.
    }
  }

  async function handleClear() {
    try {
      await clearDebugLog();
      await refresh();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : typeof err === "string" ? err : "Could not clear the debug log.",
      );
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Debug log</Text>
      <Text style={styles.hint}>
        What this app did recently -- mail server connections and login failures, sent messages, live-mail
        reconnects, CalDAV/CardDAV requests, sign-in refreshes, account changes, and desktop notifications -- with
        no passwords or tokens included. On DAV entries, a 403 means the server itself is refusing the request
        (usually a permissions setting on that calendar/address book), separate from a wrong URL (404) or a network
        problem. Select any part of the text below, or copy all of it, to share when troubleshooting.
      </Text>

      {status === "loading" && <Text style={styles.hint}>Loading...</Text>}
      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}

      {status === "loaded" && (
        <>
          <View style={styles.row}>
            <Pressable
              onPress={handleCopy}
              disabled={entries.length === 0}
              style={[styles.secondaryButton, { borderColor: accentColor }]}
            >
              <Text style={[styles.secondaryButtonText, { color: accentColor }]}>
                {copied ? "Copied" : "Copy all"}
              </Text>
            </Pressable>
            <Pressable onPress={handleClear} disabled={entries.length === 0} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Clear</Text>
            </Pressable>
            <Pressable onPress={refresh} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Refresh</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.logBox} nestedScrollEnabled>
            {entries.length === 0 ? (
              <Text style={styles.hint}>Nothing logged yet -- use the app (refresh a folder, sync, send), then hit Refresh.</Text>
            ) : (
              <Text selectable style={styles.logText}>
                {logText}
              </Text>
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: "row",
    marginBottom: spacing.md,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
    alignSelf: "flex-start",
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  logBox: {
    maxHeight: 260,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    padding: spacing.md,
  },
  logText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 18,
  },
});
