import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MailAccount } from "../data/accounts";
import {
  addContact,
  deleteContact,
  listContacts,
  searchContacts,
  updateContact,
  type ContactRecord,
} from "../lib/contacts";
import { syncCardDav } from "../lib/carddav";
import type { HoverState } from "../lib/pressable";
import { glassPanel } from "../lib/webStyle";
import { colorForKey, colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";

// One selectable address book in the sidebar: everything, the locally
// collected contacts, or a synced CardDAV book (source "carddav:<id>").
export interface AddressBookSource {
  key: string; // "all" | "local" | "carddav:<id>"
  label: string;
  carddavId?: number;
}

interface AddressBookViewProps {
  accentColor: string;
  accounts: MailAccount[];
  // The book selected in the sidebar; "all" shows every contact.
  selectedSource: AddressBookSource;
}

// Full-page address book -- the contacts equivalent of CalendarView. Lists,
// searches, edits (display name), adds, and removes contacts from whichever
// address book the sidebar has selected.
export function AddressBookView({ accentColor, selectedSource }: AddressBookViewProps) {
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [syncing, setSyncing] = useState(false);

  const sourceFilter = selectedSource.key === "all" ? undefined : selectedSource.key;

  async function refresh() {
    try {
      const trimmed = query.trim();
      const result =
        trimmed.length > 0
          ? await searchContacts(trimmed, 500, sourceFilter)
          : await listContacts(1000, sourceFilter);
      setContacts(result);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Debounced reload on search input; immediate on source change.
  useEffect(() => {
    const timer = setTimeout(() => refresh(), query.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, selectedSource.key]);

  async function handleDelete(email: string) {
    try {
      await deleteContact(email);
      setContacts((current) => current.filter((c) => c.email !== email));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startEdit(contact: ContactRecord) {
    setEditingEmail(contact.email);
    setEditDraft(contact.display_name ?? "");
  }

  async function commitEdit() {
    if (editingEmail === null) return;
    const name = editDraft.trim();
    try {
      await updateContact(editingEmail, name === "" ? null : name);
      setContacts((current) =>
        current.map((c) => (c.email === editingEmail ? { ...c, display_name: name === "" ? null : name } : c)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setEditingEmail(null);
  }

  async function handleAdd() {
    const email = newEmail.trim();
    if (email === "") return;
    try {
      await addContact(email, newName.trim() === "" ? null : newName.trim());
      setAddOpen(false);
      setNewEmail("");
      setNewName("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSync() {
    if (selectedSource.carddavId === undefined) return;
    setSyncing(true);
    try {
      await syncCardDav(selectedSource.carddavId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  function renderItem({ item }: { item: ContactRecord }) {
    const editing = editingEmail === item.email;
    const avatarColor = colorForKey(item.email);
    const initial = (item.display_name || item.email).charAt(0).toUpperCase();
    return (
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.rowText}>
          {editing ? (
            <TextInput
              style={styles.editInput}
              value={editDraft}
              onChangeText={setEditDraft}
              onSubmitEditing={commitEdit}
              onBlur={commitEdit}
              placeholder="Display name"
              placeholderTextColor={colors.text.muted}
              autoFocus
            />
          ) : (
            <Text style={styles.name}>{item.display_name || "(no name)"}</Text>
          )}
          <Text style={styles.email}>{item.email}</Text>
        </View>
        {selectedSource.key === "all" && (
          <View style={styles.sourceBadge}>
            <Text style={styles.sourceBadgeText}>{item.source === "local" ? "Local" : "CardDAV"}</Text>
          </View>
        )}
        {!editing && (
          <Pressable onPress={() => startEdit(item)} style={styles.rowAction}>
            <Text style={[styles.rowActionText, { color: accentColor }]}>Edit</Text>
          </Pressable>
        )}
        <Pressable onPress={() => handleDelete(item.email)} style={styles.rowAction}>
          <Text style={styles.rowDeleteText}>Remove</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.pane}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>{selectedSource.label}</Text>
          <View style={styles.headerActions}>
            {selectedSource.carddavId !== undefined && (
              <Pressable
                onPress={handleSync}
                disabled={syncing}
                style={({ hovered }: HoverState) => [
                  styles.headerButton,
                  hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
                ]}
              >
                <Text style={styles.headerButtonText}>{syncing ? "Syncing..." : "Sync"}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setAddOpen((value) => !value)}
              style={({ hovered }: HoverState) => [
                styles.headerButton,
                hovered && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.1) },
              ]}
            >
              <Text style={styles.headerButtonText}>+ New contact</Text>
            </Pressable>
          </View>
        </View>

        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search contacts"
          placeholderTextColor={colors.text.muted}
          autoCapitalize="none"
        />

        {addOpen && (
          <View style={styles.addForm}>
            <TextInput
              style={styles.addInput}
              value={newEmail}
              onChangeText={setNewEmail}
              placeholder="email@example.com"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              style={styles.addInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="Display name (optional)"
              placeholderTextColor={colors.text.muted}
            />
            <Pressable
              onPress={handleAdd}
              style={[styles.addButton, { backgroundColor: accentColor }]}
            >
              <Text style={styles.addButtonText}>Add</Text>
            </Pressable>
          </View>
        )}

        {error !== "" && <Text style={styles.error}>{error}</Text>}
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(item) => item.email}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query.trim() ? "No contacts match." : "No contacts in this address book yet."}
          </Text>
        }
      />
    </View>
  );
}

const paneGlass = glassPanel(colors.background.surface, 0.4, 24);

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    height: "100%",
    ...paneGlass,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text.primary,
  },
  headerActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  headerButton: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  headerButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
  search: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
  },
  addForm: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  addInput: {
    flex: 1,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
  },
  addButton: {
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  addButtonText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginTop: spacing.sm,
  },
  empty: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    textAlign: "center",
    paddingVertical: spacing.xxl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  avatarText: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.background.base,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.md,
  },
  name: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  email: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
  },
  editInput: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    marginBottom: 2,
  },
  sourceBadge: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginRight: spacing.sm,
  },
  sourceBadgeText: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    color: colors.text.muted,
  },
  rowAction: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  rowActionText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  rowDeleteText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
});
