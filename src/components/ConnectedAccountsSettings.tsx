import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listAccounts, removeAccount, type AccountRecord } from "../lib/account";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface ConnectedAccountsSettingsProps {
  accentColor: string;
  onAddAccount: () => void;
}

type ListStatus = "loading" | "loaded" | "error";

export function ConnectedAccountsSettings({ accentColor, onAddAccount }: ConnectedAccountsSettingsProps) {
  const [status, setStatus] = useState<ListStatus>("loading");
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

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
        accounts.map((account) => (
          <View key={account.account_id} style={styles.accountRow}>
            <View style={styles.accountText}>
              <Text style={styles.accountLabel}>{account.display_name ?? account.account_id}</Text>
              <Text style={styles.accountEmail}>{account.account_id}</Text>
              <Text style={styles.accountMeta}>
                {account.imap_host}:{account.imap_port} (IMAP) -- {account.smtp_host}:{account.smtp_port} (SMTP
                {account.smtp_use_starttls ? ", STARTTLS" : ""})
              </Text>
            </View>
            <Pressable onPress={() => handleRemove(account.account_id)} disabled={removingId === account.account_id}>
              <Text style={styles.removeText}>{removingId === account.account_id ? "Removing..." : "Remove"}</Text>
            </Pressable>
          </View>
        ))}

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
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
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
