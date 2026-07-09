import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isDefaultMailClient, setDefaultMailClient } from "../lib/mailto";
import { settingsStyles as styles } from "./settingsStyles";

interface DefaultMailClientSettingsProps {
  accentColor: string;
}

// Settings > General block for registering Helix as the system's mailto:
// handler. Applies immediately (it's an OS-level setting, not part of the
// staged draft). The packaged .desktop file declares the mailto MIME type,
// so this just flips the xdg default; mailto: links then launch Helix with
// compose pre-filled.
export function DefaultMailClientSettings({ accentColor }: DefaultMailClientSettingsProps) {
  const [state, setState] = useState<"checking" | "default" | "not-default" | "unsupported">("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setState("unsupported");
      return;
    }
    isDefaultMailClient()
      .then((yes) => setState(yes ? "default" : "not-default"))
      .catch(() => setState("not-default"));
  }, []);

  async function handleSetDefault() {
    setError(null);
    try {
      await setDefaultMailClient();
      const yes = await isDefaultMailClient().catch(() => true);
      setState(yes ? "default" : "not-default");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Default mail client</Text>
      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Handle mailto: links</Text>
          <Text style={styles.settingDescription}>
            {state === "checking" && "Checking the system setting..."}
            {state === "default" && "Helix is your default mail client -- email links everywhere open a pre-filled compose window."}
            {state === "not-default" &&
              "Make Helix your default mail client so clicking an email link anywhere opens compose here."}
            {state === "unsupported" && "Only available in the desktop app."}
          </Text>
        </View>
        {state === "not-default" && (
          <Pressable onPress={handleSetDefault} style={[styles.secondaryButton, { borderColor: accentColor }]}>
            <Text style={[styles.secondaryButtonText, { color: accentColor }]}>Set as default</Text>
          </Pressable>
        )}
        {state === "default" && (
          <Text style={[styles.settingLabel, { color: accentColor }]}>✓ Default</Text>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}
