import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { isTauri } from "@tauri-apps/api/core";
import { addAccount } from "../lib/account";
import { discoverServerConfig } from "../lib/discovery";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { ModalOverlay } from "./ModalOverlay";
import { Switch } from "./Switch";

type Status = "idle" | "submitting" | "success" | "error";

interface AddAccountModalProps {
  visible: boolean;
  accentColor: string;
  onClose: () => void;
  // Fired a moment after a successful add_account call, once the success
  // message has had time to register -- lets App.tsx move past the
  // welcome screen without this component knowing anything about it.
  onAdded?: () => void;
}

// Connects an account the same way Thunderbird's account wizard does:
// name/email/password up front, with server settings tucked behind an
// "advanced" disclosure for people who need a non-default IMAP/SMTP setup.
// Submitting calls the real add_account command (stores the credential,
// verifies it with a real IMAP login, persists the connection metadata --
// rolling everything back on failure), auto-discovering the IMAP/SMTP
// host+port from the email's domain first unless advanced settings are
// open. The account this adds is real and persisted -- it just isn't
// wired into the rest of the app's mailbox view yet, which still shows
// the sample ACCOUNTS list (see docs/technical/frontend-roadmap.md).
export function AddAccountModal({ visible, accentColor, onClose, onAdded }: AddAccountModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUseStarttls, setImapUseStarttls] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpUseStarttls, setSmtpUseStarttls] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const successTimeout = useRef<number | null>(null);

  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!showAdvanced || (imapHost.trim().length > 0 && smtpHost.trim().length > 0)) &&
    status !== "submitting";

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setShowAdvanced(false);
    setImapHost("");
    setImapPort("993");
    setImapUseStarttls(false);
    setSmtpHost("");
    setSmtpPort("465");
    setSmtpUseStarttls(false);
    setStatus("idle");
    setErrorMessage("");
  }

  function handleClose() {
    if (successTimeout.current !== null) {
      window.clearTimeout(successTimeout.current);
      successTimeout.current = null;
    }
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!isTauri()) {
      setStatus("error");
      setErrorMessage("Account connections only work inside the desktop app. Run 'npm run tauri dev' to use real accounts.");
      return;
    }
    setStatus("submitting");
    setErrorMessage("");
    try {
      let imap = { host: imapHost.trim(), port: Number(imapPort) };
      let smtp = { host: smtpHost.trim(), port: Number(smtpPort) };
      let useStarttls = smtpUseStarttls;
      let imapStarttls = imapUseStarttls;

      // Advanced settings, once expanded, are the user's explicit choice
      // and always win -- auto-discovery only runs when they haven't
      // bothered to override it.
      if (!showAdvanced) {
        const discovered = await discoverServerConfig(email.trim());
        imap = discovered.imap;
        smtp = discovered.smtp;
        useStarttls = discovered.smtpUseStarttls;
        // Discovered IMAP configs are always implicit TLS (port 993); the
        // discovery layer never returns a STARTTLS-only IMAP service.
        imapStarttls = false;
      }

      await addAccount({
        accountId: email.trim(),
        password,
        displayName: name.trim() === "" ? null : name.trim(),
        imapHost: imap.host,
        imapPort: imap.port,
        imapUseStarttls: imapStarttls,
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpUseStarttls: useStarttls,
        archiveFolder: null,
        trashFolder: null,
      });

      setStatus("success");
      successTimeout.current = window.setTimeout(() => {
        onAdded?.();
        handleClose();
      }, 900);
    } catch (err) {
      setStatus("error");
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      // Surface the real IMAP/backend error as-is; only mask the raw JS
      // internal-invoke error which means the user isn't in Tauri at all.
      if (msg.includes("invoke") || msg.includes("TAURI")) {
        setErrorMessage("This feature only works inside the desktop app. Run 'npm run tauri dev'.");
      } else {
        setErrorMessage(msg);
      }
    }
  }

  return (
    <ModalOverlay visible={visible} accentColor={accentColor} title="Connect an account" onClose={handleClose}>
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
          <View style={styles.starttlsRow}>
            <Switch value={imapUseStarttls} onChange={() => setImapUseStarttls((value) => !value)} color={accentColor} />
            <Text style={styles.starttlsLabel}>IMAP uses STARTTLS, not implicit TLS</Text>
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
          <View style={styles.starttlsRow}>
            <Switch value={smtpUseStarttls} onChange={() => setSmtpUseStarttls((value) => !value)} color={accentColor} />
            <Text style={styles.starttlsLabel}>SMTP uses STARTTLS, not implicit TLS</Text>
          </View>
        </View>
      )}

      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}
      {status === "success" && (
        <Text style={styles.success}>Account connected and verified -- credential stored in your OS keychain.</Text>
      )}

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
  starttlsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  starttlsLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginLeft: spacing.sm,
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
