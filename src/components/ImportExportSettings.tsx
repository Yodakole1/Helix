import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listAccounts, type AccountRecord } from "../lib/account";
import { listFolders } from "../lib/imap";
import {
  exportAccountMbox,
  exportFolderMbox,
  importEmlFiles,
  importMbox,
} from "../lib/mailstore";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { Dropdown } from "./Dropdown";

type Busy = null | "import-mbox" | "import-eml" | "export-folder" | "export-all";

// Mail migration: bring archives in (Thunderbird/Google Takeout mbox,
// loose .eml files) and get the mailbox back out (per-folder mbox or a
// full one-file-per-folder backup). Everything goes through the IMAP
// server -- imports APPEND so the mail exists everywhere, not just in
// this install's cache -- which is also why POP3 accounts aren't offered.
export function ImportExportSettings({ accentColor }: { accentColor: string }) {
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [accountId, setAccountId] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [importFolder, setImportFolder] = useState("INBOX");
  const [exportFolder, setExportFolder] = useState("INBOX");
  const [busy, setBusy] = useState<Busy>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const account = accounts.find((a) => a.account_id === accountId) ?? null;

  useEffect(() => {
    if (!isTauri()) return;
    listAccounts()
      .then((all) => {
        const imapAccounts = all.filter((a) => a.incoming_protocol !== "pop3");
        setAccounts(imapAccounts);
        if (imapAccounts.length > 0) setAccountId(imapAccounts[0].account_id);
      })
      .catch((e) => setErrorMessage(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!account) return;
    listFolders(account.account_id, account.imap_host, account.imap_port)
      .then((names) => {
        setFolders(names);
        if (names.includes("INBOX")) {
          setImportFolder("INBOX");
          setExportFolder("INBOX");
        } else if (names.length > 0) {
          setImportFolder(names[0]);
          setExportFolder(names[0]);
        }
      })
      .catch(() => setFolders([]));
  }, [accountId]);

  function report(kind: Busy, run: () => Promise<string>) {
    if (!account) return;
    setBusy(kind);
    setStatusMessage("");
    setErrorMessage("");
    run()
      .then((message) => setStatusMessage(message))
      .catch((e) => setErrorMessage(typeof e === "string" ? e : e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }

  async function handleImportMbox() {
    const path = await open({
      title: "Import mbox archive",
      multiple: false,
      filters: [{ name: "mbox archives", extensions: ["mbox", "mbx"] }, { name: "All files", extensions: ["*"] }],
    });
    if (typeof path !== "string") return;
    report("import-mbox", async () => {
      const result = await importMbox(account!.account_id, account!.imap_host, account!.imap_port, importFolder, path);
      const summary = `Imported ${result.imported} message${result.imported === 1 ? "" : "s"} into ${importFolder}.`;
      if (result.failed > 0) {
        throw `${summary} ${result.failed} failed${result.first_error ? ` -- first error: ${result.first_error}` : ""}`;
      }
      return summary;
    });
  }

  async function handleImportEml() {
    const paths = await open({
      title: "Import .eml files",
      multiple: true,
      filters: [{ name: "Email messages", extensions: ["eml"] }],
    });
    if (!Array.isArray(paths) || paths.length === 0) return;
    report("import-eml", async () => {
      const result = await importEmlFiles(account!.account_id, account!.imap_host, account!.imap_port, importFolder, paths);
      const summary = `Imported ${result.imported} of ${paths.length} file${paths.length === 1 ? "" : "s"} into ${importFolder}.`;
      if (result.failed > 0) {
        throw `${summary}${result.first_error ? ` First error: ${result.first_error}` : ""}`;
      }
      return summary;
    });
  }

  async function handleExportFolder() {
    const safeName = exportFolder.replace(/[/\\?%*:|"<>]/g, "_");
    const path = await save({
      title: "Export folder as mbox",
      defaultPath: `${safeName}.mbox`,
      filters: [{ name: "mbox archives", extensions: ["mbox"] }],
    });
    if (typeof path !== "string") return;
    report("export-folder", async () => {
      const count = await exportFolderMbox(account!.account_id, account!.imap_host, account!.imap_port, exportFolder, path);
      return `Exported ${count} message${count === 1 ? "" : "s"} from ${exportFolder}.`;
    });
  }

  async function handleExportAll() {
    const dir = await open({ title: "Choose a folder for the backup", directory: true });
    if (typeof dir !== "string") return;
    report("export-all", async () => {
      const exports = await exportAccountMbox(account!.account_id, account!.imap_host, account!.imap_port, dir);
      const total = exports.reduce((sum, f) => sum + f.messages, 0);
      return `Backed up ${total} message${total === 1 ? "" : "s"} across ${exports.length} folder${exports.length === 1 ? "" : "s"} (one .mbox per folder).`;
    });
  }

  if (!isTauri()) {
    return <Text style={styles.hint}>Import and export only work inside the desktop app.</Text>;
  }
  if (accounts.length === 0) {
    return <Text style={styles.hint}>Import and export need an IMAP account -- add one first.</Text>;
  }

  const folderOptions = folders.map((f) => ({ value: f, label: f }));

  return (
    <View>
      {accounts.length > 1 && (
        <View style={styles.accountRow}>
          {accounts.map((a) => {
            const active = a.account_id === accountId;
            return (
              <Pressable
                key={a.account_id}
                onPress={() => setAccountId(a.account_id)}
                style={[styles.accountPill, active && { backgroundColor: accentColor, borderColor: accentColor }]}
              >
                <Text style={[styles.accountPillText, active && { color: colors.background.base }]}>
                  {a.display_name ?? a.account_id}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={styles.subheading}>Import</Text>
      <Text style={styles.hint}>
        Bring mail from another client: Thunderbird and Google Takeout produce mbox archives, most clients can
        save individual messages as .eml. Imported mail is uploaded to the folder below on your mail server, so
        it shows up everywhere -- not just in Helix.
      </Text>
      <View style={styles.controlRow}>
        <Text style={styles.controlLabel}>Into folder</Text>
        <Dropdown value={importFolder} options={folderOptions} onChange={setImportFolder} accentColor={accentColor} width={200} />
      </View>
      <View style={styles.buttonRow}>
        <Pressable onPress={handleImportMbox} disabled={busy !== null} style={[styles.button, { borderColor: withAlpha(accentColor, 0.5) }, busy !== null && styles.buttonDisabled]}>
          <Text style={[styles.buttonText, { color: accentColor }]}>
            {busy === "import-mbox" ? "Importing..." : "Import mbox archive..."}
          </Text>
        </Pressable>
        <Pressable onPress={handleImportEml} disabled={busy !== null} style={[styles.button, { borderColor: withAlpha(accentColor, 0.5) }, busy !== null && styles.buttonDisabled]}>
          <Text style={[styles.buttonText, { color: accentColor }]}>
            {busy === "import-eml" ? "Importing..." : "Import .eml files..."}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.subheading}>Export</Text>
      <Text style={styles.hint}>
        Your mail back as files: one folder as an mbox archive, or the whole account as a backup directory with
        one .mbox per folder. Exports read the server without marking anything as read.
      </Text>
      <View style={styles.controlRow}>
        <Text style={styles.controlLabel}>Folder</Text>
        <Dropdown value={exportFolder} options={folderOptions} onChange={setExportFolder} accentColor={accentColor} width={200} />
      </View>
      <View style={styles.buttonRow}>
        <Pressable onPress={handleExportFolder} disabled={busy !== null} style={[styles.button, { borderColor: withAlpha(accentColor, 0.5) }, busy !== null && styles.buttonDisabled]}>
          <Text style={[styles.buttonText, { color: accentColor }]}>
            {busy === "export-folder" ? "Exporting..." : "Export folder as mbox..."}
          </Text>
        </Pressable>
        <Pressable onPress={handleExportAll} disabled={busy !== null} style={[styles.button, { borderColor: withAlpha(accentColor, 0.5) }, busy !== null && styles.buttonDisabled]}>
          <Text style={[styles.buttonText, { color: accentColor }]}>
            {busy === "export-all" ? "Backing up..." : "Back up whole account..."}
          </Text>
        </Pressable>
      </View>

      {statusMessage !== "" && <Text style={styles.status}>{statusMessage}</Text>}
      {errorMessage !== "" && <Text style={styles.error}>{errorMessage}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  subheading: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  accountRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: spacing.sm,
  },
  accountPill: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
    marginBottom: spacing.xs,
  },
  accountPillText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  controlLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginRight: spacing.sm,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  status: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.green,
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginTop: spacing.xs,
    lineHeight: 18,
  },
});
