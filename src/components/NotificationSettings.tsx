import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePersistedJSON, usePersistedState } from "../hooks/usePersistedState";
import { colors, fontFamily, radii, spacing } from "../theme";
import { sendTestNotification } from "../lib/notifications";
import { settingsStyles as styles } from "./settingsStyles";
import { Switch } from "./Switch";

const LEAD_OPTIONS = [5, 10, 15, 30];

interface NotificationSettingsProps {
  accentColor: string;
}

type PermissionState = "checking" | "granted" | "denied" | "prompt" | "unsupported";

// All real OS notification calls (@tauri-apps/plugin-notification), no
// stubs. "Notify on new mail" fires from the IMAP IDLE new-mail event in
// App.tsx; "Calendar reminders" from the per-minute reminder check there.
// Both read their setting from localStorage at trigger time, so toggling
// here applies immediately without a restart.
export function NotificationSettings({ accentColor }: NotificationSettingsProps) {
  const [permission, setPermission] = useState<PermissionState>("checking");
  const [notifyNewMail, setNotifyNewMail] = usePersistedState("helix:notifyNewMail", 0);
  const [calendarReminders, setCalendarReminders] = usePersistedJSON<boolean>("helix:calendarReminders", true);
  const [leadMinutes, setLeadMinutes] = usePersistedState("helix:reminderLeadMinutes", 10);
  // The test button is a troubleshooting tool, so it only shows in Debug
  // mode (the toggle in Settings > About). Read once on mount -- Settings
  // remounts this component whenever the user switches back to this
  // category, so a toggle in About is picked up on the next visit.
  const [debugMode] = usePersistedState("helix:debugMode", 0);
  const [testSent, setTestSent] = useState(false);
  const [testError, setTestError] = useState("");

  async function refreshPermission() {
    try {
      const granted = await isPermissionGranted();
      setPermission(granted ? "granted" : "prompt");
    } catch {
      setPermission("unsupported");
    }
  }

  useEffect(() => {
    refreshPermission();
  }, []);

  async function handleEnable() {
    try {
      const result = await requestPermission();
      setPermission(result === "granted" ? "granted" : "denied");
    } catch {
      setPermission("unsupported");
    }
  }

  async function handleSendTest() {
    setTestError("");
    try {
      await sendTestNotification();
      setTestSent(true);
      window.setTimeout(() => setTestSent(false), 2000);
    } catch (err) {
      // The backend command rejects with a real reason (no session bus,
      // Notify refused) -- show it instead of pretending the click worked.
      setTestError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Desktop notifications</Text>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Enable desktop notifications</Text>
          <Text style={styles.settingDescription}>
            {permission === "checking" && "Checking OS permission..."}
            {permission === "granted" && "Permission granted -- Helix can show real OS notifications."}
            {permission === "prompt" && "Not yet requested."}
            {permission === "denied" && "Denied at the OS level -- re-enable it from your system's notification settings."}
            {permission === "unsupported" && "Could not reach the notification backend. This only works inside the desktop app."}
          </Text>
        </View>
        {permission === "prompt" ? (
          <Pressable onPress={handleEnable} style={[styles.secondaryButton, { borderColor: accentColor }]}>
            <Text style={[styles.secondaryButtonText, { color: accentColor }]}>Enable</Text>
          </Pressable>
        ) : (
          <Switch value={permission === "granted"} onChange={handleEnable} color={accentColor} />
        )}
      </View>

      {permission === "granted" && debugMode === 1 && (
        <>
          <Pressable onPress={handleSendTest} style={[styles.secondaryButton, { borderColor: accentColor, alignSelf: "flex-start" }]}>
            <Text style={[styles.secondaryButtonText, { color: accentColor }]}>{testSent ? "Sent" : "Send test notification"}</Text>
          </Pressable>
          {testError !== "" && <Text style={local.testError}>{testError}</Text>}
        </>
      )}

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Notify on new mail</Text>
          <Text style={styles.settingDescription}>
            Fires when the live IMAP connection (IDLE) reports new messages in a watched inbox.
          </Text>
        </View>
        <Switch value={notifyNewMail === 1} onChange={() => setNotifyNewMail(notifyNewMail === 1 ? 0 : 1)} color={accentColor} />
      </View>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Calendar event reminders</Text>
          <Text style={styles.settingDescription}>
            A desktop notification shortly before each synced calendar event starts.
          </Text>
        </View>
        <Switch value={calendarReminders} onChange={() => setCalendarReminders(!calendarReminders)} color={accentColor} />
      </View>

      {calendarReminders && (
        <View style={local.leadRow}>
          <Text style={styles.settingDescription}>Remind me</Text>
          {LEAD_OPTIONS.map((minutes) => {
            const active = leadMinutes === minutes;
            return (
              <Pressable
                key={minutes}
                onPress={() => setLeadMinutes(minutes)}
                style={[local.leadPill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
              >
                <Text style={[local.leadPillText, active && { color: colors.background.base }]}>
                  {minutes} min
                </Text>
              </Pressable>
            );
          })}
          <Text style={styles.settingDescription}>before</Text>
        </View>
      )}
    </View>
  );
}

const local = StyleSheet.create({
  leadRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  leadPill: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  leadPillText: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.text.secondary,
  },
  testError: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    color: colors.accent.amber,
    marginTop: spacing.xs,
  },
});
