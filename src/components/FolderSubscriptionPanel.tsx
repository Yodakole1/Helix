import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { listFolders, listSubscribedFolders, subscribeFolder, unsubscribeFolder } from "../lib/imap";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { Switch } from "./Switch";

interface FolderSubscriptionPanelProps {
  accountId: string;
  host: string;
  port: number;
  accentColor: string;
  onClose: () => void;
}

type LoadState = "loading" | "loaded" | "error";

// Settings > Accounts > "Manage folders" panel. Shows all IMAP folders from
// LIST with toggle switches that call SUBSCRIBE/UNSUBSCRIBE. The subscribed
// set comes from LSUB. Toggling a folder updates local state optimistically
// and syncs to the server; failures revert.
export function FolderSubscriptionPanel({
  accountId,
  host,
  port,
  accentColor,
  onClose,
}: FolderSubscriptionPanelProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setError("");
    Promise.all([
      listFolders(accountId, host, port),
      listSubscribedFolders(accountId, host, port),
    ])
      .then(([all, subs]) => {
        if (cancelled) return;
        setAllFolders(all);
        setSubscribed(new Set(subs));
        setLoadState("loaded");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, host, port]);

  async function handleToggle(folder: string, currentlySubscribed: boolean) {
    if (toggling) return;
    setToggling(folder);
    setSubscribed((prev) => {
      const next = new Set(prev);
      if (currentlySubscribed) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
    try {
      if (currentlySubscribed) {
        await unsubscribeFolder(accountId, host, port, folder);
      } else {
        await subscribeFolder(accountId, host, port, folder);
      }
    } catch (e) {
      // Revert on failure
      setSubscribed((prev) => {
        const next = new Set(prev);
        if (currentlySubscribed) {
          next.add(folder);
        } else {
          next.delete(folder);
        }
        return next;
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(null);
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>Folder subscriptions</Text>
        <Pressable onPress={onClose}>
          <Text style={[styles.closeText, { color: accentColor }]}>Done</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>
        Subscribed folders appear in the sidebar. Unsubscribed folders still exist on the server.
      </Text>

      {loadState === "loading" && <Text style={styles.statusText}>Loading folders...</Text>}
      {loadState === "error" && <Text style={styles.errorText}>{error}</Text>}

      {loadState === "loaded" && (
        <ScrollView style={styles.list}>
          {allFolders.map((folder) => {
            const isSub = subscribed.has(folder);
            return (
              <View key={folder} style={styles.row}>
                <Text
                  style={[styles.folderName, toggling === folder && styles.folderNameBusy]}
                  numberOfLines={1}
                >
                  {folder}
                </Text>
                <Switch
                  value={isSub}
                  onChange={() => handleToggle(folder, isSub)}
                  color={accentColor}
                />
              </View>
            );
          })}
          {allFolders.length === 0 && (
            <Text style={styles.statusText}>No folders found.</Text>
          )}
        </ScrollView>
      )}

      {error !== "" && loadState === "loaded" && (
        <Text style={[styles.errorText, { marginTop: spacing.sm }]}>{error}</Text>
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
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  closeText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 16,
    marginBottom: spacing.sm,
  },
  list: {
    maxHeight: 280,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  folderName: {
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.primary,
    marginRight: spacing.md,
  },
  folderNameBusy: {
    opacity: 0.5,
  },
  statusText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    paddingVertical: spacing.sm,
  },
  errorText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
  },
});
