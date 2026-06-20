import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { storeCredential } from "../lib/credentials";
import type { Accent } from "../theme";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ModalOverlay } from "./ModalOverlay";

type Status = "idle" | "submitting" | "success" | "error";

interface AddAccountModalProps {
  visible: boolean;
  accent: Accent;
  onClose: () => void;
}

// Connects an account the same way Thunderbird's account wizard does:
// name/email/password up front, with server settings tucked behind an
// "advanced" disclosure for people who need a non-default IMAP/SMTP setup.
// The password is the only thing that actually goes anywhere right now --
// it's handed to the Rust-side OS keychain via storeCredential. There's no
// account list or IMAP sync to add it to yet.
export function AddAccountModal({ visible, accent, onClose }: AddAccountModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const accentColor = colors.accent[accent];
  const canSubmit = email.trim().length > 0 && password.length > 0 && status !== "submitting";

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setShowAdvanced(false);
    setStatus("idle");
    setErrorMessage("");
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit() {
    setStatus("submitting");
    try {
      await storeCredential(email.trim(), password);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Could not reach the secure storage backend. This only works inside the desktop app.",
      );
    }
  }

  return (
    <ModalOverlay visible={visible} accent={accent} title="Connect an account" onClose={handleClose}>
      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Work"
        placeholderTextColor={colors.text.muted}
      />

      <Text style={styles.label}>Email address</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor={colors.text.muted}
        autoCapitalize="none"
        keyboardType="email-address"
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="App password or account password"
        placeholderTextColor={colors.text.muted}
        secureTextEntry
      />

      <Pressable onPress={() => setShowAdvanced((value) => !value)} style={styles.advancedToggle}>
        <Text style={[styles.advancedToggleText, { color: accentColor }]}>
          {showAdvanced ? "Hide" : "Show"} advanced server settings
        </Text>
      </Pressable>

      {showAdvanced && (
        <View style={styles.advanced}>
          <View style={styles.row}>
            <View style={styles.col}>
              <Text style={styles.label}>IMAP host</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={imapHost}
                onChangeText={setImapHost}
                placeholder="imap.example.com"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="none"
              />
            </View>
            <View style={styles.colNarrow}>
              <Text style={styles.label}>Port</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={imapPort}
                onChangeText={setImapPort}
                keyboardType="number-pad"
              />
            </View>
          </View>
          <View style={styles.row}>
            <View style={styles.col}>
              <Text style={styles.label}>SMTP host</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={smtpHost}
                onChangeText={setSmtpHost}
                placeholder="smtp.example.com"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="none"
              />
            </View>
            <View style={styles.colNarrow}>
              <Text style={styles.label}>Port</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={smtpPort}
                onChangeText={setSmtpPort}
                keyboardType="number-pad"
              />
            </View>
          </View>
        </View>
      )}

      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}
      {status === "success" && <Text style={styles.success}>Credential stored securely in your OS keychain.</Text>}

      <View style={styles.actions}>
        <Pressable onPress={handleClose} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          style={[styles.primaryButton, { backgroundColor: accentColor }, !canSubmit && styles.primaryButtonDisabled]}
        >
          <Text style={styles.primaryButtonText}>{status === "submitting" ? "Connecting..." : "Connect"}</Text>
        </Pressable>
      </View>
    </ModalOverlay>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  mono: {
    fontFamily: fontFamily.mono,
  },
  advancedToggle: {
    marginBottom: spacing.md,
  },
  advancedToggleText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  advanced: {
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
  },
  col: {
    flex: 1,
    marginRight: spacing.sm,
  },
  colNarrow: {
    width: 88,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  success: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.green,
    marginBottom: spacing.md,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: spacing.sm,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  primaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  primaryButtonDisabled: {
    opacity: 0.4,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
});
