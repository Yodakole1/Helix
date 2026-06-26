import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePersistedState } from "../hooks/usePersistedState";
import { settingsStyles as styles } from "./settingsStyles";
import { Switch } from "./Switch";

interface NotificationSettingsProps {
  accentColor: string;
}

type PermissionState = "checking" | "granted" | "denied" | "prompt" | "unsupported";

// Real where the OS lets it be real: isPermissionGranted/requestPermission/
// sendNotification (@tauri-apps/plugin-notification, wired into
// src-tauri/Cargo.toml + lib.rs + capabilities/default.json this pass) are
// genuine OS notification calls, not stubs. "Notify on new mail" stays
// inert -- there's no new-mail-detection loop anywhere in this app yet
// (no IMAP IDLE, no polling, see backend-backlog.md), so nothing exists
// to trigger it regardless of permission state. Its value still persists
// so a future real trigger has something to read.
export function NotificationSettings({ accentColor }: NotificationSettingsProps) {
  const [permission, setPermission] = useState<PermissionState>("checking");
  const [notifyNewMail, setNotifyNewMail] = usePersistedState("helix:notifyNewMail", 0);
  const [testSent, setTestSent] = useState(false);

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

  function handleSendTest() {
    sendNotification({ title: "Helix", body: "This is a test notification." });
    setTestSent(true);
    window.setTimeout(() => setTestSent(false), 2000);
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

      {permission === "granted" && (
        <Pressable onPress={handleSendTest} style={[styles.secondaryButton, { borderColor: accentColor, alignSelf: "flex-start" }]}>
          <Text style={[styles.secondaryButtonText, { color: accentColor }]}>{testSent ? "Sent" : "Send test notification"}</Text>
        </Pressable>
      )}

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Notify on new mail</Text>
          <Text style={styles.settingDescription}>
            There's no background mail-checking yet (no IMAP IDLE, no polling) -- this won't fire automatically until
            that exists, but the setting is saved for when it does.
          </Text>
        </View>
        <Switch value={notifyNewMail === 1} onChange={() => setNotifyNewMail(notifyNewMail === 1 ? 0 : 1)} color={accentColor} />
      </View>
    </View>
  );
}
