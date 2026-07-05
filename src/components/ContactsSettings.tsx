import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  addCardDavSource,
  deleteCardDavSource,
  discoverCardDav,
  listCardDavSources,
  syncCardDav,
  type CardDavDiscoveredBook,
  type CardDavSource,
} from "../lib/carddav";
import { deleteContact, listContacts, searchContacts, type ContactRecord } from "../lib/contacts";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { settingsStyles } from "./settingsStyles";

interface ContactsSettingsProps {
  accentColor: string;
}

type Status = "loading" | "loaded" | "error";

// ── CardDAV sub-component ─────────────────────────────────────────────────────

function CardDavSection({
  accentColor,
  onContactsChanged,
}: {
  accentColor: string;
  // Fired after an add or sync lands new contacts in the local cache, so
  // the contact list below shows them immediately.
  onContactsChanged?: () => void;
}) {
  const [sources, setSources] = useState<CardDavSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-form state
  const [host, setHost] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [discovered, setDiscovered] = useState<CardDavDiscoveredBook[]>([]);
  const [manualUrl, setManualUrl] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    listCardDavSources()
      .then(setSources)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const handleSync = async (id: number) => {
    setError(null);
    setSyncing(id);
    try {
      await syncCardDav(id);
      setSources(await listCardDavSources());
      onContactsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(null);
    }
  };

  const handleDelete = async (id: number) => {
    setError(null);
    try {
      await deleteCardDavSource(id);
      setSources((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  // Server to discover against: what was typed, or the domain of an
  // email-style username -- username + password alone is usually enough.
  const effectiveHost = host.trim() || (username.includes("@") ? username.split("@")[1].trim() : "");

  const handleDiscover = async () => {
    if (!effectiveHost || !username.trim() || !password) {
      setError("Server (or an email-address username), username, and password are required.");
      return;
    }
    setError(null);
    setDiscovering(true);
    try {
      const books = await discoverCardDav(effectiveHost, username.trim(), password);
      if (books.length > 0) {
        setDiscovered(books);
        setUrl(books[0].url);
        setDisplayName(books[0].display_name ?? "");
      } else {
        setError("No address books found on that server. You can enter the URL manually below.");
        setManualUrl(true);
      }
    } catch (e) {
      setError(String(e));
      setManualUrl(true);
    } finally {
      setDiscovering(false);
    }
  };

  const handleAdd = async () => {
    if (!url || !username || !password) {
      setError("URL, username, and password are required.");
      return;
    }
    setError(null);
    setAdding(true);
    try {
      // add_carddav_source performs the initial sync itself, so contacts
      // are already in the local cache when this resolves.
      const src = await addCardDavSource(username, url, username, password, displayName || url);
      setSources((prev) => [...prev, src]);
      setShowAdd(false);
      setHost(""); setUrl(""); setUsername(""); setPassword(""); setDisplayName("");
      setDiscovered([]);
      setManualUrl(false);
      onContactsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={settingsStyles.sectionTitle}>CardDAV address books</Text>
      <Text style={settingsStyles.hint}>
        Sync contacts from CardDAV servers. Contacts are merged into the local address book and available in autocomplete.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {sources.map((src) => (
        <View key={src.id} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{src.display_name || src.url}</Text>
            <Text style={styles.email}>{src.username} — {src.url}</Text>
          </View>
          <Pressable
            style={styles.actionBtn}
            onPress={() => handleSync(src.id)}
            disabled={syncing === src.id}
          >
            <Text style={[styles.actionBtnText, { color: accentColor }]}>
              {syncing === src.id ? "Syncing…" : "Sync"}
            </Text>
          </Pressable>
          <Pressable onPress={() => handleDelete(src.id)}>
            <Text style={styles.delete}>Remove</Text>
          </Pressable>
        </View>
      ))}

      {showAdd ? (
        <View style={styles.addForm}>
          <Text style={settingsStyles.hint}>
            Username and password are usually enough — Helix finds the address
            books on the server itself.
          </Text>
          <Text style={styles.fieldLabel}>Username</Text>
          <TextInput
            style={styles.search}
            value={username}
            onChangeText={setUsername}
            placeholder="user@example.com"
            placeholderTextColor={colors.text.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.fieldLabel}>Password</Text>
          <TextInput
            style={styles.search}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.text.muted}
            secureTextEntry
            autoCorrect={false}
          />
          <Text style={styles.fieldLabel}>Server (optional — defaults to your username's domain)</Text>
          <TextInput
            style={styles.search}
            value={host}
            onChangeText={setHost}
            placeholder={username.includes("@") ? username.split("@")[1] : "carddav.example.com"}
            placeholderTextColor={colors.text.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          {discovered.length > 0 && (
            <>
              <Text style={styles.fieldLabel}>Select address book</Text>
              {discovered.map((book) => (
                <Pressable
                  key={book.url}
                  onPress={() => {
                    setUrl(book.url);
                    setDisplayName(book.display_name ?? "");
                  }}
                  style={[
                    styles.bookRow,
                    url === book.url && { borderColor: accentColor },
                  ]}
                >
                  <Text style={styles.name}>{book.display_name ?? "(unnamed address book)"}</Text>
                  <Text style={styles.email} numberOfLines={1}>{book.url}</Text>
                </Pressable>
              ))}
            </>
          )}

          {manualUrl && (
            <>
              <Text style={styles.fieldLabel}>Address book URL</Text>
              <TextInput
                style={styles.search}
                value={url}
                onChangeText={setUrl}
                placeholder="https://carddav.example.com/addressbooks/user/default/"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}

          {(discovered.length > 0 || manualUrl) && (
            <>
              <Text style={styles.fieldLabel}>Display name (optional)</Text>
              <TextInput
                style={styles.search}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="My Contacts"
                placeholderTextColor={colors.text.muted}
              />
            </>
          )}

          <View style={styles.formBtns}>
            <Pressable onPress={() => setShowAdd(false)}>
              <Text style={styles.delete}>Cancel</Text>
            </Pressable>
            {discovered.length === 0 && !manualUrl ? (
              <Pressable onPress={handleDiscover} disabled={discovering}>
                <Text style={[styles.actionBtnText, { color: accentColor }]}>
                  {discovering ? "Searching…" : "Find address books"}
                </Text>
              </Pressable>
            ) : (
              <Pressable onPress={handleAdd} disabled={adding}>
                <Text style={[styles.actionBtnText, { color: accentColor }]}>
                  {adding ? "Adding…" : "Add address book"}
                </Text>
              </Pressable>
            )}
          </View>
          {!manualUrl && discovered.length === 0 && (
            <Pressable onPress={() => setManualUrl(true)} style={{ alignSelf: "flex-end" }}>
              <Text style={[styles.actionBtnText, { color: accentColor }]}>
                Enter a URL manually instead
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        <Pressable onPress={() => setShowAdd(true)}>
          <Text style={[styles.actionBtnText, { color: accentColor }]}>+ Add address book</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Main contacts panel ───────────────────────────────────────────────────────

// The address book accumulates automatically from every message read or
// sent (see contacts.md). This view lists it and lets the user forget a
// one-off or mistyped address that would otherwise linger in autocomplete.
export function ContactsSettings({ accentColor }: ContactsSettingsProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [query, setQuery] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  async function refresh(search: string) {
    setStatus("loading");
    try {
      const trimmed = search.trim();
      const result = trimmed.length > 0 ? await searchContacts(trimmed, 200) : await listContacts(500);
      setContacts(result);
      setStatus("loaded");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not load contacts.");
      setStatus("error");
    }
  }

  useEffect(() => {
    refresh("");
  }, []);

  // Debounce the search so each keystroke doesn't hit the cache.
  useEffect(() => {
    const timer = setTimeout(() => refresh(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function handleDelete(email: string) {
    try {
      await deleteContact(email);
      setContacts((current) => current.filter((contact) => contact.email !== email));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : typeof err === "string" ? err : "Could not delete that contact.");
    }
  }

  return (
    <View>
      <CardDavSection accentColor={accentColor} onContactsChanged={() => refresh(query)} />

      <Text style={settingsStyles.sectionTitle}>Contacts</Text>
      <Text style={settingsStyles.hint}>
        Built up automatically from addresses you read mail from or send to. Removing one only forgets it locally; it
        comes back if you correspond with that address again.
      </Text>

      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search contacts"
        placeholderTextColor={colors.text.muted}
        autoCapitalize="none"
      />

      {status === "loading" && <Text style={settingsStyles.hint}>Loading...</Text>}
      {status === "error" && <Text style={styles.error}>{errorMessage}</Text>}
      {status === "loaded" && contacts.length === 0 && (
        <Text style={settingsStyles.hint}>{query.trim() ? "No contacts match." : "No contacts yet."}</Text>
      )}

      {contacts.map((contact) => (
        <View key={contact.email} style={styles.row}>
          <View style={styles.text}>
            {contact.display_name && <Text style={styles.name}>{contact.display_name}</Text>}
            <Text style={styles.email}>{contact.email}</Text>
          </View>
          <Pressable onPress={() => handleDelete(contact.email)}>
            <Text style={styles.delete}>Remove</Text>
          </Pressable>
        </View>
      ))}

      {errorMessage !== "" && status === "loaded" && <Text style={styles.error}>{errorMessage}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
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
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
  },
  text: {
    flex: 1,
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
  delete: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
  error: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.accent.amber,
    marginBottom: spacing.md,
  },
  fieldLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: 4,
    marginTop: spacing.sm,
  },
  addForm: {
    backgroundColor: colors.background.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bookRow: {
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.panel,
    marginBottom: spacing.xs,
  },
  formBtns: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  actionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  actionBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
