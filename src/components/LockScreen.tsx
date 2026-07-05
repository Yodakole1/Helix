import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { passkeyUnlock, verifyAppLockPassword, type AppLockConfig } from "../lib/lock";
import { glassPanel } from "../lib/webStyle";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

interface LockScreenProps {
  accentColor: string;
  config: AppLockConfig;
  onUnlock: () => void;
}

// Shown once per app start when a lock method is enrolled. Unlocking with
// either enrolled method (password or passkey) opens the mailbox for the
// rest of the session -- there is no re-lock timer; the lock guards the
// app *start*, matching "unlock once after booting the machine".
export function LockScreen({ accentColor, config, onUnlock }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handlePassword() {
    if (password.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const ok = await verifyAppLockPassword(password);
      if (ok) {
        onUnlock();
      } else {
        setError("Wrong password.");
        setPassword("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePasskey() {
    setBusy(true);
    setError("");
    try {
      const ok = await passkeyUnlock(showPin && pin ? pin : undefined);
      if (ok) {
        onUnlock();
      } else {
        setError("The security key's response didn't verify.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A key with a PIN set refuses assertions without one -- surface the
      // PIN field instead of a dead-end error.
      if (msg.toLowerCase().includes("pin")) {
        setShowPin(true);
        setError("This security key needs its PIN.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={[styles.lockBadge, { backgroundColor: withAlpha(accentColor, 0.15) }]}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </View>
        <Text style={styles.title}>Your inbox is locked</Text>
        <Text style={styles.subtitle}>
          {config.passkey_set && config.password_set
            ? "Insert and touch your security key, or enter your password."
            : config.passkey_set
              ? "Insert and touch your security key to unlock."
              : "Enter your password to unlock."}
        </Text>

        {config.password_set && (
          <>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={handlePassword}
              placeholder="Password"
              placeholderTextColor={colors.text.muted}
              secureTextEntry
              autoFocus
            />
            <Pressable
              onPress={handlePassword}
              disabled={busy || password.length === 0}
              style={[
                styles.primaryButton,
                { backgroundColor: accentColor },
                (busy || password.length === 0) && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>Unlock</Text>
            </Pressable>
          </>
        )}

        {config.passkey_set && (
          <>
            {showPin && (
              <TextInput
                style={styles.input}
                value={pin}
                onChangeText={setPin}
                placeholder="Security key PIN"
                placeholderTextColor={colors.text.muted}
                secureTextEntry
              />
            )}
            <Pressable
              onPress={handlePasskey}
              disabled={busy}
              style={[
                styles.passkeyButton,
                { borderColor: accentColor },
                busy && styles.buttonDisabled,
              ]}
            >
              <Text style={[styles.passkeyButtonText, { color: accentColor }]}>
                {busy ? "Waiting for key..." : "Unlock with security key"}
              </Text>
            </Pressable>
          </>
        )}

        {error !== "" && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}

const cardGlass = glassPanel(colors.background.panel, 0.6, 32);

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background.base,
    zIndex: 100,
  },
  card: {
    width: 360,
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.strong,
    alignItems: "center",
    ...cardGlass,
  },
  lockBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  input: {
    alignSelf: "stretch",
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    marginBottom: spacing.sm,
  },
  primaryButton: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    marginBottom: spacing.sm,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  passkeyButton: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  passkeyButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    textAlign: "center",
    marginTop: spacing.xs,
  },
});
