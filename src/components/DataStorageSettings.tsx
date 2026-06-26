import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cacheStats, clearCache, type CacheStats } from "../lib/cache";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";

interface DataStorageSettingsProps {
  accentColor: string;
}

type Status = "loading" | "loaded" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Real: src-tauri/src/cache.rs's cache_stats/clear_cache, added this pass
// specifically for this section. clear_cache only ever touches cached
// message summaries/bodies -- accounts, contacts, and PGP keys survive
// it, see the doc comment on the Rust side for why.
export function DataStorageSettings({ accentColor }: DataStorageSettingsProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function refresh() {
    setStatus("loading");
    try {
      const result = await cacheStats();
      setStats(result);
      setStatus("loaded");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not read cache stats.");
      setStatus("error");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleClear() {
    setClearing(true);
    try {
      await clearCache();
      setConfirming(false);
      await refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not clear the cache.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Local encrypted cache</Text>
      <Text style={styles.hint}>
        Cached mail is stored in a SQLCipher-encrypted database on this device, separate from your account
        credentials (OS keychain) and PGP keys (same database, a different table -- clearing the cache below never
        touches them).
      </Text>

      {status === "loading" && <Text style={styles.hint}>Loading...</Text>}
      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}

      {status === "loaded" && stats && (
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{stats.message_count}</Text>
            <Text style={styles.statLabel}>cached messages</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{formatBytes(stats.size_bytes)}</Text>
            <Text style={styles.statLabel}>on disk</Text>
          </View>
        </View>
      )}

      {!confirming ? (
        <Pressable onPress={() => setConfirming(true)} style={[styles.secondaryButton, { borderColor: accentColor }]}>
          <Text style={[styles.secondaryButtonText, { color: accentColor }]}>Clear cache</Text>
        </Pressable>
      ) : (
        <View>
          <Text style={styles.confirmText}>
            This deletes every cached message summary/body. They'll be re-fetched next time you open the relevant
            folder. Continue?
          </Text>
          <View style={styles.row}>
            <Pressable onPress={() => setConfirming(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleClear}
              disabled={clearing}
              style={[styles.primaryButton, { backgroundColor: colors.accent.amber }]}
            >
              <Text style={styles.primaryButtonText}>{clearing ? "Clearing..." : "Clear cache"}</Text>
            </Pressable>
          </View>
        </View>
      )}
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
  statsRow: {
    flexDirection: "row",
    marginBottom: spacing.lg,
  },
  stat: {
    marginRight: spacing.xl,
  },
  statValue: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  statLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  confirmText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.md,
    lineHeight: 18,
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
    alignSelf: "flex-start",
  },
  secondaryButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.secondary,
  },
});
