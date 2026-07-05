import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { addIdentity, deleteIdentity, listIdentities, type IdentitySummary } from "../lib/identities";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface IdentitySettingsProps {
  accountId: string;
  accentColor: string;
}

// Inline panel in Settings > Accounts for managing send-as identities (aliases)
// for a single IMAP account. The primary address is the account itself and
// cannot be removed; additional aliases added here appear in the From: picker
// in the compose window.
export function IdentitySettings({ accountId, accentColor }: IdentitySettingsProps) {
  const [identities, setIdentities] = useState<IdentitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingAddr, setRemovingAddr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setIdentities(await listIdentities(accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [accountId]);

  async function handleAdd() {
    if (!address.trim()) return;
    setSaving(true);
    setError("");
    try {
      await addIdentity(accountId, address.trim(), displayName.trim() || null, signature.trim() || null);
      setAddress("");
      setDisplayName("");
      setSignature("");
      setAddOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(addr: string) {
    setRemovingAddr(addr);
    try {
      await deleteIdentity(accountId, addr);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingAddr(null);
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>Send-as aliases</Text>
        <Pressable onPress={() => setAddOpen((v) => !v)}>
          <Text style={[styles.action, { color: accentColor }]}>{addOpen ? "Cancel" : "+ Add alias"}</Text>
        </Pressable>
      </View>

      {loading && <Text style={styles.muted}>Loading...</Text>}
      {error !== "" && <Text style={styles.errorText}>{error}</Text>}

      {!loading && identities.length === 0 && !addOpen && (
        <Text style={styles.muted}>No aliases. The account address is always available as From.</Text>
      )}

      {identities.map((id) => (
        <View key={id.address} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.address}>{id.address}</Text>
            {id.display_name ? <Text style={styles.name}>{id.display_name}</Text> : null}
          </View>
          <Pressable onPress={() => handleDelete(id.address)} disabled={removingAddr === id.address}>
            <Text style={styles.removeText}>
              {removingAddr === id.address ? "Removing..." : "Remove"}
            </Text>
          </Pressable>
        </View>
      ))}

      {addOpen && (
        <View style={styles.addForm}>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="alias@example.com"
            placeholderTextColor={colors.text.muted}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Display name (optional)"
            placeholderTextColor={colors.text.muted}
          />
          <TextInput
            style={[styles.input, styles.multiline]}
            value={signature}
            onChangeText={setSignature}
            placeholder="Signature for this alias (optional)"
            placeholderTextColor={colors.text.muted}
            multiline
            numberOfLines={3}
          />
          <Pressable
            onPress={handleAdd}
            disabled={saving || !address.trim()}
            style={[styles.saveButton, { backgroundColor: accentColor }, (saving || !address.trim()) && styles.disabled]}
          >
            <Text style={styles.saveText}>{saving ? "Saving..." : "Add alias"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: spacing.sm,
    backgroundColor: colors.background.panel,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    padding: spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  action: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  muted: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 16,
  },
  errorText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  rowText: { flex: 1 },
  address: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
  },
  name: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    color: colors.text.muted,
  },
  removeText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
    marginLeft: spacing.md,
  },
  addForm: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.primary,
  },
  multiline: {
    height: 64,
    textAlignVertical: "top",
  },
  saveButton: {
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: radii.sm,
    marginTop: spacing.xs,
  },
  disabled: { opacity: 0.5 },
  saveText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
});
