import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  deleteContactSmimeCert,
  deleteSmimeCert,
  exportSmimeCert,
  importContactSmimeCert,
  importSmimeCert,
  listContactSmimeCerts,
  listOwnSmimeCerts,
  type SmimeContactCertInfo,
} from "../lib/smime";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface SmimeSettingsProps {
  accountId: string;
  accountLabel: string;
  accentColor: string;
}

type OwnStatus = "checking" | "none" | "present";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function certExpired(notAfter: string): boolean {
  return new Date(notAfter) < new Date();
}

function certExpiringSoon(notAfter: string): boolean {
  const msLeft = new Date(notAfter).getTime() - Date.now();
  return msLeft > 0 && msLeft < 30 * 86400 * 1000;
}

// Read a file as standard base64 (no data-URL prefix).
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      resolve(btoa(bin));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// Settings > Privacy & Security -- S/MIME certificate management for own
// account certs and harvested / manually imported contact certs.
export function SmimeSettings({ accountId, accountLabel, accentColor }: SmimeSettingsProps) {
  const [ownStatus, setOwnStatus] = useState<OwnStatus>("checking");
  const [ownCn, setOwnCn] = useState<string | null>(null);
  const [ownFingerprint, setOwnFingerprint] = useState("");
  const [ownNotAfter, setOwnNotAfter] = useState("");
  const [ownPem, setOwnPem] = useState("");
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Import form state.
  const [showImport, setShowImport] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const p12InputRef = useRef<HTMLInputElement>(null);

  // Contact cert state.
  const [contactCerts, setContactCerts] = useState<SmimeContactCertInfo[]>([]);
  const [contactFile, setContactFile] = useState<File | null>(null);
  const [contactEmail, setContactEmail] = useState("");
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState("");
  const contactCertInputRef = useRef<HTMLInputElement>(null);

  // Check on mount + when accountId changes whether this account already has a
  // cert stored. list_own_smime_certs returns all accounts so we filter.
  useEffect(() => {
    let cancelled = false;
    setOwnStatus("checking");
    setError("");
    setShowImport(false);
    setOwnPem("");
    setImportFile(null);
    setImportPassword("");

    Promise.all([listOwnSmimeCerts(), listContactSmimeCerts()])
      .then(([own, contact]) => {
        if (cancelled) return;
        const mine = own.find((c) => c.account_id === accountId);
        if (mine) {
          setOwnStatus("present");
          setOwnCn(mine.subject_cn);
          setOwnFingerprint(mine.fingerprint);
          setOwnNotAfter(mine.not_after);
        } else {
          setOwnStatus("none");
        }
        setContactCerts(contact);
      })
      .catch(() => {
        if (!cancelled) setOwnStatus("none");
      });

    return () => { cancelled = true; };
  }, [accountId]);

  function handlePickP12() {
    p12InputRef.current?.click();
  }

  function handleP12Selected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setImportFile(file);
    event.target.value = "";
  }

  async function handleImportCert() {
    if (!importFile) return;
    setImportBusy(true);
    setImportError("");
    try {
      const b64 = await fileToBase64(importFile);
      await importSmimeCert(accountId, b64, importPassword);
      // Reload own cert list to get the new cert's info.
      const all = await listOwnSmimeCerts();
      const mine = all.find((c) => c.account_id === accountId);
      if (mine) {
        setOwnStatus("present");
        setOwnCn(mine.subject_cn);
        setOwnFingerprint(mine.fingerprint);
        setOwnNotAfter(mine.not_after);
      }
      setShowImport(false);
      setImportFile(null);
      setImportPassword("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not import that certificate.");
    } finally {
      setImportBusy(false);
    }
  }

  async function handleExportPem() {
    if (ownPem) {
      await navigator.clipboard.writeText(ownPem);
      setCopyConfirmed(true);
      window.setTimeout(() => setCopyConfirmed(false), 1500);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const pem = await exportSmimeCert(accountId);
      setOwnPem(pem);
      await navigator.clipboard.writeText(pem);
      setCopyConfirmed(true);
      window.setTimeout(() => setCopyConfirmed(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export certificate.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteOwnCert() {
    setBusy(true);
    setError("");
    try {
      await deleteSmimeCert(accountId);
      setOwnStatus("none");
      setOwnCn(null);
      setOwnFingerprint("");
      setOwnNotAfter("");
      setOwnPem("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the certificate.");
    } finally {
      setBusy(false);
    }
  }

  function handlePickContactCert() {
    contactCertInputRef.current?.click();
  }

  function handleContactCertSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setContactFile(file);
    event.target.value = "";
  }

  async function handleImportContactCert() {
    if (!contactFile && contactEmail.trim() === "") return;
    if (!contactFile) {
      setContactError("Choose a certificate file (.pem or .cer) first.");
      return;
    }
    setContactBusy(true);
    setContactError("");
    try {
      const b64 = await fileToBase64(contactFile);
      const email = contactEmail.trim();
      await importContactSmimeCert(email !== "" ? email : contactFile.name.replace(/\.\w+$/, ""), b64);
      // Reload contact cert list.
      const all = await listContactSmimeCerts();
      setContactCerts(all);
      setContactFile(null);
      setContactEmail("");
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Could not import that certificate.");
    } finally {
      setContactBusy(false);
    }
  }

  async function handleDeleteContactCert(email: string) {
    try {
      await deleteContactSmimeCert(email);
      setContactCerts((prev) => prev.filter((c) => c.email !== email));
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Could not remove that certificate.");
    }
  }

  const expired = ownStatus === "present" && certExpired(ownNotAfter);
  const expiringSoon = ownStatus === "present" && certExpiringSoon(ownNotAfter);
  const expiryColor = expired ? colors.accent.amber : expiringSoon ? colors.accent.amber : colors.text.secondary;

  return (
    <View>
      <Text style={styles.sectionTitle}>S/MIME certificate -- {accountLabel}</Text>
      <Text style={styles.hint}>
        S/MIME uses X.509 certificates to sign outgoing messages and decrypt received ones. Your certificate is issued
        by a certificate authority and stored in a PKCS#12 file (.p12 or .pfx). Free personal certificates are
        available from Actalis and other CAs.
      </Text>

      {ownStatus === "checking" && (
        <Text style={styles.hint}>Checking for an existing certificate...</Text>
      )}

      {ownStatus === "present" && !showImport && (
        <View>
          <View style={styles.certCard}>
            {ownCn !== null && (
              <View style={styles.certRow}>
                <Text style={styles.certLabel}>Subject</Text>
                <Text style={styles.certValue}>{ownCn}</Text>
              </View>
            )}
            <View style={styles.certRow}>
              <Text style={styles.certLabel}>Fingerprint</Text>
              <Text style={[styles.certValue, styles.mono]}>{ownFingerprint}</Text>
            </View>
            <View style={styles.certRow}>
              <Text style={styles.certLabel}>Expires</Text>
              <Text style={[styles.certValue, { color: expiryColor }]}>
                {formatDate(ownNotAfter)}
                {expired ? "  (expired)" : expiringSoon ? "  (expiring soon)" : ""}
              </Text>
            </View>
          </View>

          {error !== "" && <Text style={styles.error}>{error}</Text>}

          <View style={styles.row}>
            <Pressable
              onPress={handleExportPem}
              disabled={busy}
              style={[styles.secondaryButton, { borderColor: accentColor }]}
            >
              <Text style={[styles.secondaryButtonText, { color: accentColor }]}>
                {copyConfirmed ? "Copied" : "Copy public cert (PEM)"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setShowImport(true)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Replace certificate</Text>
            </Pressable>
            <Pressable
              onPress={handleDeleteOwnCert}
              disabled={busy}
              style={styles.secondaryButton}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.accent.amber }]}>
                {busy ? "Removing..." : "Remove"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {(ownStatus === "none" || showImport) && (
        <View>
          {ownStatus === "none" && (
            <Text style={styles.hint}>No certificate on file for this account yet.</Text>
          )}
          <input
            ref={p12InputRef}
            type="file"
            accept=".p12,.pfx"
            onChange={handleP12Selected}
            style={{ display: "none" }}
          />
          <View style={styles.row}>
            <Pressable
              onPress={handlePickP12}
              style={[styles.primaryButton, { backgroundColor: accentColor }]}
            >
              <Text style={styles.primaryButtonText}>
                {importFile ? importFile.name : "Choose .p12 / .pfx file..."}
              </Text>
            </Pressable>
            {showImport && (
              <Pressable onPress={() => { setShowImport(false); setImportFile(null); setImportPassword(""); setImportError(""); }} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            )}
          </View>
          {importFile && (
            <>
              <Text style={styles.label}>Certificate password</Text>
              <TextInput
                style={styles.input}
                value={importPassword}
                onChangeText={setImportPassword}
                placeholder="Password for this .p12 file"
                placeholderTextColor={colors.text.muted}
                secureTextEntry
                autoCapitalize="none"
              />
              {importError !== "" && <Text style={styles.error}>{importError}</Text>}
              <Pressable
                onPress={handleImportCert}
                disabled={importBusy}
                style={[styles.primaryButton, { backgroundColor: accentColor, alignSelf: "flex-start" }]}
              >
                <Text style={styles.primaryButtonText}>{importBusy ? "Importing..." : "Import certificate"}</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Contact certificates: auto-harvested from signed mail + manually imported */}
      <Text style={styles.sectionTitle}>Contact certificates</Text>
      <Text style={styles.hint}>
        Collected automatically when you open a verified signed message. Import a contact's certificate manually
        to send them encrypted mail without having exchanged a signed message first.
      </Text>

      {contactCerts.length > 0 && (
        <View style={styles.contactList}>
          {contactCerts.map((cert) => {
            const exp = certExpired(cert.not_after);
            const soon = certExpiringSoon(cert.not_after);
            const dateColor = exp ? colors.accent.amber : soon ? colors.accent.amber : colors.text.muted;
            return (
              <View key={cert.email} style={styles.contactRow}>
                <View style={styles.contactRowContent}>
                  <Text style={styles.contactEmail} numberOfLines={1}>{cert.email}</Text>
                  {cert.subject_cn !== null && (
                    <Text style={styles.contactMeta} numberOfLines={1}>{cert.subject_cn}</Text>
                  )}
                  <Text style={[styles.contactMeta, { color: dateColor }]}>
                    Expires {formatDate(cert.not_after)}{exp ? " (expired)" : soon ? " (soon)" : ""}
                  </Text>
                </View>
                <Pressable onPress={() => handleDeleteContactCert(cert.email)} style={styles.removeButton}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <input
        ref={contactCertInputRef}
        type="file"
        accept=".pem,.cer,.crt,.der"
        onChange={handleContactCertSelected}
        style={{ display: "none" }}
      />

      <Text style={styles.label}>Contact email (if not embedded in the certificate)</Text>
      <TextInput
        style={styles.input}
        value={contactEmail}
        onChangeText={setContactEmail}
        placeholder="contact@example.com"
        placeholderTextColor={colors.text.muted}
        autoCapitalize="none"
      />

      <View style={styles.row}>
        <Pressable
          onPress={handlePickContactCert}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>
            {contactFile ? contactFile.name : "Choose certificate file..."}
          </Text>
        </Pressable>
        {contactFile && (
          <Pressable
            onPress={handleImportContactCert}
            disabled={contactBusy}
            style={[styles.primaryButton, { backgroundColor: accentColor }]}
          >
            <Text style={styles.primaryButtonText}>{contactBusy ? "Importing..." : "Import"}</Text>
          </Pressable>
        )}
      </View>

      {contactError !== "" && <Text style={styles.error}>{contactError}</Text>}
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
    marginTop: spacing.sm,
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
  certCard: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  certRow: {
    flexDirection: "row",
    marginBottom: 6,
  },
  certLabel: {
    width: 84,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  certValue: {
    flex: 1,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  primaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
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
  contactList: {
    marginBottom: spacing.md,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  contactRowContent: {
    flex: 1,
    marginRight: spacing.sm,
  },
  contactEmail: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 2,
  },
  contactMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
    marginBottom: 1,
  },
  removeButton: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  removeText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
  },
});
