import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { deleteContactKey, deleteOwnKey, exportPublicKey, generateKeypair, importContactKey, importOwnKey, listContactKeys, type StoredContactKey } from "../lib/pgp";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface PgpKeySettingsProps {
  accountId: string;
  accountLabel: string;
  accentColor: string;
}

type KeyStatus = "checking" | "none" | "present";

// Settings > Privacy & Security's key-management section -- the one place
// in the frontend that actually calls src-tauri/src/pgp.rs. Modeled on
// AddAccountModal's status-state-machine shape: a real backend call per
// action, errors surfaced as-is rather than papered over.
export function PgpKeySettings({ accountId, accountLabel, accentColor }: PgpKeySettingsProps) {
  const [status, setStatus] = useState<KeyStatus>("checking");
  const [fingerprint, setFingerprint] = useState("");
  const [exportedPublicKey, setExportedPublicKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importSecretKey, setImportSecretKey] = useState("");
  const [copyConfirmed, setCopyConfirmed] = useState(false);

  const [contactEmail, setContactEmail] = useState("");
  const [contactPublicKey, setContactPublicKey] = useState("");
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState("");
  const [contactKeys, setContactKeys] = useState<StoredContactKey[]>([]);

  // export_public_key doubles as the "does a key already exist" check --
  // its only realistic failure is "no PGP key on file for this account",
  // so there's no separate has_key command to call first. Contact keys are
  // loaded alongside it so the list survives session restarts.
  useEffect(() => {
    let cancelled = false;
    setStatus("checking");
    setErrorMessage("");
    setShowImport(false);
    exportPublicKey(accountId)
      .then((info) => {
        if (cancelled) return;
        setFingerprint(info.fingerprint);
        setExportedPublicKey(info.public_key);
        setStatus("present");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("none");
      });
    listContactKeys()
      .then((keys) => { if (!cancelled) setContactKeys(keys); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function handleGenerate() {
    setBusy(true);
    setErrorMessage("");
    try {
      const info = await generateKeypair(accountId, accountLabel);
      setFingerprint(info.fingerprint);
      setExportedPublicKey(info.public_key);
      setStatus("present");
      setShowImport(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not generate a key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleImportOwnKey() {
    if (importSecretKey.trim() === "") return;
    setBusy(true);
    setErrorMessage("");
    try {
      const info = await importOwnKey(accountId, importSecretKey.trim());
      setFingerprint(info.fingerprint);
      setExportedPublicKey(info.public_key);
      setStatus("present");
      setShowImport(false);
      setImportSecretKey("");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not import that key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteOwnKey() {
    setBusy(true);
    setErrorMessage("");
    try {
      await deleteOwnKey(accountId);
      setFingerprint("");
      setExportedPublicKey("");
      setStatus("none");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Could not remove the key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyPublicKey() {
    await navigator.clipboard.writeText(exportedPublicKey);
    setCopyConfirmed(true);
    window.setTimeout(() => setCopyConfirmed(false), 1500);
  }

  async function handleImportContactKey() {
    if (contactEmail.trim() === "" || contactPublicKey.trim() === "") return;
    setContactBusy(true);
    setContactError("");
    try {
      await importContactKey(contactEmail.trim(), contactPublicKey.trim());
      setContactEmail("");
      setContactPublicKey("");
      // Reload the full list so the new entry shows with its real fingerprint
      // and imported_at, and is sorted consistently with older entries.
      listContactKeys().then(setContactKeys).catch(() => {});
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Could not import that key.");
    } finally {
      setContactBusy(false);
    }
  }

  async function handleDeleteContactKey(email: string) {
    try {
      await deleteContactKey(email);
      setContactKeys((current) => current.filter((key) => key.email !== email));
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Could not remove that key.");
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Encryption key -- {accountLabel}</Text>

      {status === "checking" && <Text style={styles.hint}>Checking for an existing key...</Text>}

      {status === "present" && (
        <View>
          <Text style={styles.fingerprintLabel}>Fingerprint</Text>
          <Text style={styles.fingerprint}>{fingerprint}</Text>
          <View style={styles.row}>
            <Pressable onPress={handleCopyPublicKey} style={[styles.secondaryButton, { borderColor: accentColor }]}>
              <Text style={[styles.secondaryButtonText, { color: accentColor }]}>
                {copyConfirmed ? "Copied" : "Copy public key"}
              </Text>
            </Pressable>
            <Pressable onPress={handleGenerate} disabled={busy} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{busy ? "Working..." : "Regenerate"}</Text>
            </Pressable>
            <Pressable onPress={handleDeleteOwnKey} disabled={busy} style={styles.secondaryButton}>
              <Text style={[styles.secondaryButtonText, { color: colors.accent.amber }]}>
                {busy ? "Working..." : "Remove key"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {status === "none" && !showImport && (
        <View>
          <Text style={styles.hint}>No encryption key on file for this account yet.</Text>
          <View style={styles.row}>
            <Pressable
              onPress={handleGenerate}
              disabled={busy}
              style={[styles.primaryButton, { backgroundColor: accentColor }]}
            >
              <Text style={styles.primaryButtonText}>{busy ? "Generating..." : "Generate new key"}</Text>
            </Pressable>
            <Pressable onPress={() => setShowImport(true)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Import existing key</Text>
            </Pressable>
          </View>
        </View>
      )}

      {showImport && status === "none" && (
        <View>
          <Text style={styles.label}>Armored secret key</Text>
          <TextInput
            style={styles.textarea}
            value={importSecretKey}
            onChangeText={setImportSecretKey}
            placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
            placeholderTextColor={colors.text.muted}
            multiline
            textAlignVertical="top"
          />
          <View style={styles.row}>
            <Pressable onPress={() => setShowImport(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleImportOwnKey}
              disabled={busy}
              style={[styles.primaryButton, { backgroundColor: accentColor }]}
            >
              <Text style={styles.primaryButtonText}>{busy ? "Importing..." : "Import"}</Text>
            </Pressable>
          </View>
        </View>
      )}

      {errorMessage !== "" && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.sectionTitle}>Contact keys</Text>
      <Text style={styles.hint}>
        Import a contact's public key to send them encrypted mail.
      </Text>

      {contactKeys.length > 0 && (
        <View style={styles.importedList}>
          {contactKeys.map((key) => (
            <View key={key.email} style={styles.importedRow}>
              <View style={styles.importedRowContent}>
                <Text style={styles.importedEmail} numberOfLines={1}>{key.email}</Text>
                <Text style={styles.importedFingerprint} numberOfLines={1}>{key.fingerprint}</Text>
              </View>
              <Pressable onPress={() => handleDeleteContactKey(key.email)} style={styles.deleteKeyButton}>
                <Text style={styles.deleteKeyText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.label}>Contact email</Text>
      <TextInput
        style={styles.input}
        value={contactEmail}
        onChangeText={setContactEmail}
        placeholder="contact@example.com"
        placeholderTextColor={colors.text.muted}
        autoCapitalize="none"
      />
      <Text style={styles.label}>Armored public key</Text>
      <TextInput
        style={styles.textarea}
        value={contactPublicKey}
        onChangeText={setContactPublicKey}
        placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
        placeholderTextColor={colors.text.muted}
        multiline
        textAlignVertical="top"
      />
      {contactError !== "" && <Text style={styles.error}>{contactError}</Text>}
      <Pressable
        onPress={handleImportContactKey}
        disabled={contactBusy}
        style={[styles.primaryButton, { backgroundColor: accentColor, alignSelf: "flex-start" }]}
      >
        <Text style={styles.primaryButtonText}>{contactBusy ? "Importing..." : "Import contact key"}</Text>
      </Pressable>
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
    marginTop: spacing.lg,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
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
  textarea: {
    minHeight: 90,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  fingerprintLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  fingerprint: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: "row",
  },
  primaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  primaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  importedList: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  importedRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  importedRowContent: {
    flex: 1,
    marginRight: spacing.sm,
  },
  importedEmail: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginBottom: 2,
  },
  importedFingerprint: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
  },
  deleteKeyButton: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  deleteKeyText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
  },
});
