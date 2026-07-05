import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

type Phase = "idle" | "checking" | "none" | "available" | "downloading" | "ready";

// Check-for-updates UI over tauri-plugin-updater. Updates are downloaded
// from the GitHub release feed configured in tauri.conf.json and verified
// against the signing key baked into the binary -- an unsigned or
// tampered package fails verification and never installs, which is the
// whole point of shipping an update channel for a security-focused app.
// Deliberately manual (a button, not a background nag): checking phones
// GitHub, and this codebase doesn't phone anywhere without being asked.
export function UpdateSettings({ accentColor }: { accentColor: string }) {
  const [currentVersion, setCurrentVersion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({ done: 0, total: null });
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (isTauri()) getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  async function handleCheck() {
    if (!isTauri()) {
      setErrorMessage("Update checks only work inside the desktop app.");
      return;
    }
    setPhase("checking");
    setErrorMessage("");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setPhase("available");
      } else {
        setPhase("none");
      }
    } catch (err) {
      setPhase("idle");
      setErrorMessage(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
    }
  }

  async function handleInstall() {
    if (!update) return;
    setPhase("downloading");
    setErrorMessage("");
    let done = 0;
    let total: number | null = null;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setProgress({ done: 0, total });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setProgress({ done, total });
        }
      });
      setPhase("ready");
    } catch (err) {
      setPhase("available");
      setErrorMessage(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
    }
  }

  const progressLabel =
    progress.total !== null
      ? `${Math.round((progress.done / progress.total) * 100)}%`
      : `${(progress.done / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <View style={styles.block}>
      <Text style={styles.versionText}>
        Current version: {currentVersion === "" ? "unknown (browser build)" : currentVersion}
      </Text>

      {phase === "available" && update && (
        <Text style={styles.updateText}>
          Version {update.version} is available.
          {update.body ? ` ${update.body}` : ""}
        </Text>
      )}
      {phase === "none" && <Text style={styles.okText}>You're on the latest version.</Text>}
      {phase === "downloading" && <Text style={styles.updateText}>Downloading... {progressLabel}</Text>}
      {phase === "ready" && (
        <Text style={styles.updateText}>
          Update installed. Restart Helix to finish -- your mail and settings are untouched.
        </Text>
      )}
      {errorMessage !== "" && <Text style={styles.error}>{errorMessage}</Text>}

      <View style={styles.buttonRow}>
        {(phase === "idle" || phase === "none" || phase === "checking") && (
          <Pressable
            onPress={handleCheck}
            disabled={phase === "checking"}
            style={[styles.button, { borderColor: withAlpha(accentColor, 0.5) }]}
          >
            <Text style={[styles.buttonText, { color: accentColor }]}>
              {phase === "checking" ? "Checking..." : "Check for updates"}
            </Text>
          </Pressable>
        )}
        {phase === "available" && (
          <Pressable onPress={handleInstall} style={[styles.button, styles.buttonFilled, { backgroundColor: accentColor }]}>
            <Text style={[styles.buttonText, { color: colors.background.base }]}>Download and install</Text>
          </Pressable>
        )}
        {phase === "ready" && (
          <Pressable
            onPress={() => relaunch()}
            style={[styles.button, styles.buttonFilled, { backgroundColor: accentColor }]}
          >
            <Text style={[styles.buttonText, { color: colors.background.base }]}>Restart now</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    marginBottom: spacing.lg,
  },
  versionText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  updateText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginBottom: spacing.sm,
    lineHeight: 20,
  },
  okText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.accent.green,
    marginBottom: spacing.sm,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: "row",
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: "transparent",
  },
  buttonFilled: {
    borderWidth: 0,
  },
  buttonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
