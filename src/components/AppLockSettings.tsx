import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  clearAppLockPasskey,
  clearAppLockPassword,
  getAppLockConfig,
  registerAppLockPasskey,
  setAppLockPassword,
  type AppLockConfig,
} from "../lib/lock";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { settingsStyles } from "./settingsStyles";

interface AppLockSettingsProps {
  accentColor: string;
}

// App-lock enrollment: a password, a FIDO2 security key, or both. These are
// immediate actions (hardware enrollment can't be staged behind Save), so
// unlike the toggles above they apply as soon as they succeed. Both methods
// are strictly optional -- with neither enrolled, Helix opens unlocked.
export function AppLockSettings({ accentColor }: AppLockSettingsProps) {
  const [config, setConfig] = useState<AppLockConfig | null>(null);
  const [password, setPassword] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function refresh() {
    getAppLockConfig().then(setConfig).catch((e) => setError(String(e)));
  }
  useEffect(refresh, []);

  async function handleSetPassword() {
    if (password.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await setAppLockPassword(password);
      setPassword("");
      setPasswordOpen(false);
      setNotice("Lock password saved. Helix will ask for it on the next start.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearPassword() {
    setError("");
    try {
      await clearAppLockPassword();
      setNotice("Lock password removed.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRegisterPasskey() {
    setBusy(true);
    setError("");
    setNotice("Touch your security key when it blinks...");
    try {
      await registerAppLockPasskey(pinOpen && pin ? pin : undefined);
      setPin("");
      setPinOpen(false);
      setNotice("Security key enrolled. Helix will accept it on the next start.");
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNotice("");
      if (msg.toLowerCase().includes("pin") && !pinOpen) {
        setPinOpen(true);
        setError("This security key has a PIN -- enter it below and try again.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleClearPasskey() {
    setError("");
    try {
      await clearAppLockPasskey();
      setNotice("Security key removed.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!config) return null;

  return (
    <View>
      <Text style={settingsStyles.sectionTitle}>App lock</Text>
      <Text style={settingsStyles.hint}>
        Ask for a password and/or a security key once when Helix starts -- after unlocking, the inbox stays
        open until the app is closed. Both are optional; with neither set, Helix opens straight to your mail.
      </Text>

      <View style={styles.methodRow}>
        <View style={styles.methodText}>
          <Text style={styles.methodLabel}>Password</Text>
          <Text style={styles.methodStatus}>{config.password_set ? "Enabled" : "Not set"}</Text>
        </View>
        {config.password_set ? (
          <Pressable onPress={handleClearPassword}>
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => setPasswordOpen((value) => !value)}>
            <Text style={[styles.action, { color: accentColor }]}>Set password</Text>
          </Pressable>
        )}
      </View>

      {passwordOpen && !config.password_set && (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={handleSetPassword}
            placeholder="Choose a lock password"
            placeholderTextColor={colors.text.muted}
            secureTextEntry
            autoFocus
          />
          <Pressable
            onPress={handleSetPassword}
            disabled={busy || password.length === 0}
            style={[styles.saveButton, { backgroundColor: accentColor }, (busy || password.length === 0) && styles.disabled]}
          >
            <Text style={styles.saveButtonText}>Save</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.methodRow}>
        <View style={styles.methodText}>
          <Text style={styles.methodLabel}>Security key (passkey)</Text>
          <Text style={styles.methodStatus}>
            {config.passkey_set
              ? "Enrolled"
              : config.passkey_available
                ? "Not enrolled"
                : "Not available in this build"}
          </Text>
        </View>
        {config.passkey_set ? (
          <Pressable onPress={handleClearPasskey}>
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        ) : config.passkey_available ? (
          <Pressable onPress={handleRegisterPasskey} disabled={busy}>
            <Text style={[styles.action, { color: accentColor }, busy && styles.disabled]}>
              {busy ? "Waiting for key..." : "Enroll key"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {!config.passkey_available && (
        <Text style={settingsStyles.hint}>
          Passkey unlock needs a build with the `passkey` feature (on Linux, install libudev-dev and rebuild
          with --features passkey). Password lock works in every build.
        </Text>
      )}

      {pinOpen && config.passkey_available && !config.passkey_set && (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder="Security key PIN"
            placeholderTextColor={colors.text.muted}
            secureTextEntry
          />
          <Pressable
            onPress={handleRegisterPasskey}
            disabled={busy}
            style={[styles.saveButton, { backgroundColor: accentColor }, busy && styles.disabled]}
          >
            <Text style={styles.saveButtonText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {notice !== "" && <Text style={styles.notice}>{notice}</Text>}
      {error !== "" && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  methodRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  methodText: {
    flex: 1,
    marginRight: spacing.md,
  },
  methodLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 2,
  },
  methodStatus: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  action: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  remove: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
  inlineForm: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
  },
  saveButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  saveButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  disabled: {
    opacity: 0.4,
  },
  notice: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.green,
    marginTop: spacing.sm,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginTop: spacing.sm,
  },
});
