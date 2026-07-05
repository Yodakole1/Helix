import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { listAccounts, removeAccount, updateAccount, type AccountRecord } from "../lib/account";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { FolderSubscriptionPanel } from "./FolderSubscriptionPanel";
import { IdentitySettings } from "./IdentitySettings";
import { Switch } from "./Switch";

interface ConnectedAccountsSettingsProps {
  accentColor: string;
  onAddAccount: () => void;
}

type ListStatus = "loading" | "loaded" | "error";

// Editable connection fields, seeded from an AccountRecord when editing opens.
interface EditForm {
  imapHost: string;
  imapPort: string;
  imapUseStarttls: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUseStarttls: boolean;
  // Empty means "leave the stored password untouched".
  password: string;
}

export function ConnectedAccountsSettings({ accentColor, onAddAccount }: ConnectedAccountsSettingsProps) {
  const [status, setStatus] = useState<ListStatus>("loading");
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Which account has the folder subscription panel open.
  const [folderSubsFor, setFolderSubsFor] = useState<string | null>(null);
  // Which account has the identity (alias) panel open.
  const [identitiesFor, setIdentitiesFor] = useState<string | null>(null);

  function startEdit(account: AccountRecord) {
    setEditingId(account.account_id);
    setErrorMessage("");
    setEditForm({
      imapHost: account.imap_host,
      imapPort: String(account.imap_port),
      imapUseStarttls: account.imap_use_starttls,
      smtpHost: account.smtp_host,
      smtpPort: String(account.smtp_port),
      smtpUseStarttls: account.smtp_use_starttls,
      password: "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }

  async function handleSaveEdit(account: AccountRecord) {
    if (!editForm) return;
    setSavingEdit(true);
    setErrorMessage("");
    try {
      await updateAccount({
        accountId: account.account_id,
        password: editForm.password.length > 0 ? editForm.password : null,
        displayName: account.display_name,
        imapHost: editForm.imapHost.trim(),
        imapPort: Number(editForm.imapPort),
        imapUseStarttls: editForm.imapUseStarttls,
        smtpHost: editForm.smtpHost.trim(),
        smtpPort: Number(editForm.smtpPort),
        smtpUseStarttls: editForm.smtpUseStarttls,
      });
      cancelEdit();
      await refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not update that account.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function refresh() {
    setStatus("loading");
    try {
      const result = await listAccounts();
      setAccounts(result);
      setStatus("loaded");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not load accounts.");
      setStatus("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleRemove(accountId: string) {
    setRemovingId(accountId);
    try {
      await removeAccount(accountId);
      await refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not remove that account.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <View>
      <View style={styles.titleRow}>
        <Text style={styles.sectionTitle}>Connected accounts</Text>
        <View style={styles.titleActions}>
          <Pressable onPress={refresh} style={styles.refreshButton}>
            <Text style={[styles.refresh, { color: accentColor }]}>Refresh</Text>
          </Pressable>
          <Pressable
            onPress={onAddAccount}
            style={[styles.addButton, { backgroundColor: accentColor, shadowColor: accentColor }]}
          >
            <Text style={styles.addButtonText}>+ Add account</Text>
          </Pressable>
        </View>
      </View>

      {status === "loading" && <Text style={styles.hint}>Loading...</Text>}
      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}

      {status === "loaded" && accounts.length === 0 && (
        <Text style={styles.hint}>No accounts yet. Use the button above to add one.</Text>
      )}

      {status === "loaded" &&
        accounts.map((account) => {
          const isPop3 = account.incoming_protocol === "pop3";
          const incoming = isPop3
            ? `${account.pop3_host ?? ""}:${account.pop3_port ?? ""} (POP3)`
            : `${account.imap_host}:${account.imap_port} (IMAP${account.imap_use_starttls ? ", STARTTLS" : ""})`;
          const editing = editingId === account.account_id;
          return (
            <View key={account.account_id} style={styles.accountCard}>
              <View style={styles.accountRow}>
                <View style={styles.accountText}>
                  <Text style={styles.accountLabel}>{account.display_name ?? account.account_id}</Text>
                  <Text style={styles.accountEmail}>{account.account_id}</Text>
                  <Text style={styles.accountMeta}>
                    {incoming} -- {account.smtp_host}:{account.smtp_port} (SMTP
                    {account.smtp_use_starttls ? ", STARTTLS" : ""})
                  </Text>
                </View>
                <View style={styles.rowActions}>
                  {!isPop3 && (
                    <Pressable onPress={() => setFolderSubsFor(folderSubsFor === account.account_id ? null : account.account_id)}>
                      <Text style={[styles.editText, { color: accentColor }]}>
                        {folderSubsFor === account.account_id ? "Close" : "Folders"}
                      </Text>
                    </Pressable>
                  )}
                  {!isPop3 && (
                    <Pressable onPress={() => setIdentitiesFor(identitiesFor === account.account_id ? null : account.account_id)}>
                      <Text style={[styles.editText, { color: accentColor }]}>
                        {identitiesFor === account.account_id ? "Close" : "Aliases"}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => (editing ? cancelEdit() : startEdit(account))}>
                    <Text style={[styles.editText, { color: accentColor }]}>{editing ? "Cancel" : "Edit"}</Text>
                  </Pressable>
                  <Pressable onPress={() => handleRemove(account.account_id)} disabled={removingId === account.account_id}>
                    <Text style={styles.removeText}>{removingId === account.account_id ? "Removing..." : "Remove"}</Text>
                  </Pressable>
                </View>
              </View>

              {folderSubsFor === account.account_id && !isPop3 && (
                <FolderSubscriptionPanel
                  accountId={account.account_id}
                  host={account.imap_host}
                  port={account.imap_port}
                  accentColor={accentColor}
                  onClose={() => setFolderSubsFor(null)}
                />
              )}

              {identitiesFor === account.account_id && !isPop3 && (
                <IdentitySettings
                  accountId={account.account_id}
                  accentColor={accentColor}
                />
              )}

              {editing && editForm && (
                <View style={styles.editForm}>
                  {!isPop3 && (
                    <View style={styles.fieldRow}>
                      <TextInput
                        style={[styles.fieldInput, styles.fieldGrow]}
                        value={editForm.imapHost}
                        onChangeText={(text) => setEditForm((f) => (f ? { ...f, imapHost: text } : f))}
                        placeholder="imap.example.com"
                        placeholderTextColor={colors.text.muted}
                        autoCapitalize="none"
                      />
                      <TextInput
                        style={[styles.fieldInput, styles.fieldPort]}
                        value={editForm.imapPort}
                        onChangeText={(text) => setEditForm((f) => (f ? { ...f, imapPort: text } : f))}
                        keyboardType="number-pad"
                      />
                    </View>
                  )}
                  {!isPop3 && (
                    <View style={styles.toggleRow}>
                      <Switch
                        value={editForm.imapUseStarttls}
                        onChange={() => setEditForm((f) => (f ? { ...f, imapUseStarttls: !f.imapUseStarttls } : f))}
                        color={accentColor}
                      />
                      <Text style={styles.toggleLabel}>IMAP uses STARTTLS</Text>
                    </View>
                  )}
                  <View style={styles.fieldRow}>
                    <TextInput
                      style={[styles.fieldInput, styles.fieldGrow]}
                      value={editForm.smtpHost}
                      onChangeText={(text) => setEditForm((f) => (f ? { ...f, smtpHost: text } : f))}
                      placeholder="smtp.example.com"
                      placeholderTextColor={colors.text.muted}
                      autoCapitalize="none"
                    />
                    <TextInput
                      style={[styles.fieldInput, styles.fieldPort]}
                      value={editForm.smtpPort}
                      onChangeText={(text) => setEditForm((f) => (f ? { ...f, smtpPort: text } : f))}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={styles.toggleRow}>
                    <Switch
                      value={editForm.smtpUseStarttls}
                      onChange={() => setEditForm((f) => (f ? { ...f, smtpUseStarttls: !f.smtpUseStarttls } : f))}
                      color={accentColor}
                    />
                    <Text style={styles.toggleLabel}>SMTP uses STARTTLS</Text>
                  </View>
                  <TextInput
                    style={[styles.fieldInput, styles.fieldFull]}
                    value={editForm.password}
                    onChangeText={(text) => setEditForm((f) => (f ? { ...f, password: text } : f))}
                    placeholder="New password (leave blank to keep current)"
                    placeholderTextColor={colors.text.muted}
                    secureTextEntry
                  />
                  <Pressable
                    onPress={() => handleSaveEdit(account)}
                    disabled={savingEdit}
                    style={[styles.saveButton, { backgroundColor: accentColor }, savingEdit && styles.saveButtonDisabled]}
                  >
                    <Text style={styles.saveButtonText}>{savingEdit ? "Verifying..." : "Save & verify"}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}

      {errorMessage !== "" && status === "loaded" && <Text style={styles.error}>{errorMessage}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
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
  titleActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  refreshButton: {
    marginRight: spacing.md,
  },
  refresh: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  addButton: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  addButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  accountCard: {
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  editText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  editForm: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  fieldRow: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  fieldInput: {
    backgroundColor: colors.background.panel,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
  },
  fieldGrow: {
    flex: 1,
  },
  fieldPort: {
    width: 72,
  },
  fieldFull: {
    fontFamily: fontFamily.ui,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 2,
  },
  toggleLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  saveButton: {
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: radii.sm,
    marginTop: spacing.xs,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.background.base,
  },
  accountText: {
    flex: 1,
  },
  accountLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  accountEmail: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.muted,
  },
  accountMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.secondary,
    marginTop: 2,
  },
  removeText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
});
