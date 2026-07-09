import React, { useCallback, useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  CalDavDiscoveredCalendar,
  CalDavSource,
  CalendarEvent,
  addCalDavSource,
  deleteCalDavSource,
  discoverCalDav,
  icalToIso,
  listCalDavSources,
  listCalendarEvents,
  syncCalDav,
} from "../lib/caldav";
import { emitCalendarBus } from "../lib/calendarBus";
import { colors, fontFamily, withAlpha } from "../theme";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(dt: string | null): string {
  if (!dt) return "";
  // iCal compact: "20260701T100000Z" → readable
  if (/^\d{8}T\d{6}Z?$/.test(dt)) {
    const y = dt.slice(0, 4);
    const m = dt.slice(4, 6);
    const d = dt.slice(6, 8);
    const h = dt.slice(9, 11);
    const min = dt.slice(11, 13);
    return `${y}-${m}-${d} ${h}:${min}`;
  }
  // ISO 8601 — trim seconds/ms
  return dt.slice(0, 16).replace("T", " ");
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SourceRow({
  source,
  onSync,
  onDelete,
  syncing,
}: {
  source: CalDavSource;
  onSync: () => void;
  onDelete: () => void;
  syncing: boolean;
}) {
  return (
    <View style={styles.sourceRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.sourceName}>
          {source.display_name ?? source.url}
        </Text>
        <Text style={styles.sourceMeta}>
          {source.username} — {source.url}
        </Text>
        {source.last_synced_at && (
          <Text style={styles.sourceSynced}>
            Last synced {fmt(source.last_synced_at)}
          </Text>
        )}
      </View>
      <Pressable
        style={[styles.btn, styles.btnSecondary]}
        onPress={onSync}
        disabled={syncing}
      >
        <Text style={styles.btnText}>{syncing ? "Syncing…" : "Sync"}</Text>
      </Pressable>
      <Pressable style={[styles.btn, styles.btnDanger]} onPress={onDelete}>
        <Text style={styles.btnText}>Remove</Text>
      </Pressable>
    </View>
  );
}

function EventRow({ event, accentColor }: { event: CalendarEvent; accentColor: string }) {
  return (
    <View style={styles.eventRow}>
      <View style={[styles.eventDot, { backgroundColor: accentColor }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.eventTitle}>{event.summary ?? "(no title)"}</Text>
        <Text style={styles.eventMeta}>
          {fmt(event.dtstart)}
          {event.dtend ? ` → ${fmt(event.dtend)}` : ""}
          {event.location ? ` · ${event.location}` : ""}
        </Text>
      </View>
    </View>
  );
}

// ── Add source form ───────────────────────────────────────────────────────────

interface AddFormState {
  host: string;
  url: string;
  username: string;
  password: string;
  displayName: string;
}

// In-progress form values, kept at module level so switching to another
// settings category (or closing Settings) mid-form doesn't discard what's
// typed. Cleared on Add/Cancel. In-memory only -- it holds a password, so
// it must never move to localStorage.
const EMPTY_FORM: AddFormState = { host: "", url: "", username: "", password: "", displayName: "" };
let formDraft: AddFormState = EMPTY_FORM;
let formDraftOpen = false;

function AddSourceForm({
  accentColor,
  onAdded,
  onCancel,
}: {
  accentColor: string;
  onAdded: (src: CalDavSource) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AddFormState>(formDraft);
  useEffect(() => {
    formDraft = form;
  }, [form]);
  const [discovered, setDiscovered] = useState<CalDavDiscoveredCalendar[]>([]);
  const [manualUrl, setManualUrl] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof AddFormState) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Server to discover against: what was typed, or mail.<domain>:2080
  // derived from an email-style username -- the common self-hosted layout,
  // same guess the calendar tab's add form makes -- so "you@example.com" +
  // password is enough.
  const usernameDomain = /@([^\s@]+\.[^\s@]+)$/.exec(form.username.trim())?.[1];
  const effectiveHost = form.host.trim() || (usernameDomain ? `mail.${usernameDomain}:2080` : "");

  const handleDiscover = async () => {
    if (!effectiveHost || !form.username.trim() || !form.password) {
      setError("Server (or an email-address username), username, and password are required.");
      return;
    }
    setError(null);
    setDiscovering(true);
    try {
      const cals = await discoverCalDav({
        host: effectiveHost,
        username: form.username.trim(),
        password: form.password,
      });
      if (cals.length === 0) {
        setError("No calendars found on that server. You can enter the calendar URL manually below.");
        setManualUrl(true);
      } else {
        setDiscovered(cals);
        const first = cals[0];
        setForm((f) => ({
          ...f,
          url: first.url,
          displayName: first.display_name ?? "",
        }));
      }
    } catch (e) {
      setError(String(e));
      setManualUrl(true);
    } finally {
      setDiscovering(false);
    }
  };

  const handleAdd = async () => {
    if (!form.url || !form.username || !form.password) {
      setError("URL, username, and password are required.");
      return;
    }
    setError(null);
    setAdding(true);
    try {
      const src = await addCalDavSource({
        accountId: form.username,
        url: form.url,
        username: form.username,
        password: form.password,
        displayName: form.displayName || undefined,
      });
      formDraft = EMPTY_FORM;
      onAdded(src);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <View style={[styles.card, { marginBottom: 20 }]}>
      <Text style={styles.sectionLabel}>Add CalDAV calendar</Text>
      <Text style={styles.hintText}>
        Username and password are usually enough — Helix finds the calendars
        on the server itself, like Thunderbird does.
      </Text>

      <Text style={styles.fieldLabel}>Username</Text>
      <TextInput
        style={styles.input}
        placeholder="user@example.com"
        placeholderTextColor={colors.text.muted}
        value={form.username}
        onChangeText={set("username")}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>Password / app password</Text>
      <TextInput
        style={styles.input}
        placeholder="••••••••"
        placeholderTextColor={colors.text.muted}
        value={form.password}
        onChangeText={set("password")}
        secureTextEntry
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>
        Server (optional — defaults to your username's domain)
      </Text>
      <TextInput
        style={styles.input}
        placeholder={form.username.includes("@") ? form.username.split("@")[1] : "caldav.example.com"}
        placeholderTextColor={colors.text.muted}
        value={form.host}
        onChangeText={set("host")}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {discovered.length > 0 && (
        <>
          <Text style={styles.fieldLabel}>Select calendar</Text>
          {discovered.map((c) => (
            <Pressable
              key={c.url}
              style={[
                styles.discoveredRow,
                form.url === c.url && {
                  borderColor: accentColor,
                  backgroundColor: withAlpha(accentColor, 0.12),
                },
              ]}
              onPress={() =>
                setForm((f) => ({
                  ...f,
                  url: c.url,
                  displayName: c.display_name ?? "",
                }))
              }
            >
              <Text style={styles.discoveredName}>
                {c.display_name ?? c.url}
              </Text>
              <Text style={styles.discoveredUrl}>{c.url}</Text>
            </Pressable>
          ))}
        </>
      )}

      {manualUrl && (
        <>
          <Text style={styles.fieldLabel}>Calendar URL</Text>
          <TextInput
            style={styles.input}
            placeholder="https://caldav.example.com/calendars/user/default/"
            placeholderTextColor={colors.text.muted}
            value={form.url}
            onChangeText={set("url")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      {(discovered.length > 0 || manualUrl) && (
        <>
          <Text style={styles.fieldLabel}>Display name (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="My Calendar"
            placeholderTextColor={colors.text.muted}
            value={form.displayName}
            onChangeText={set("displayName")}
          />
        </>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      <View style={styles.formBtns}>
        <Pressable
          style={[styles.btn, styles.btnSecondary]}
          onPress={() => {
            // Explicitly leaving the form discards the draft; only an
            // unmount mid-typing (category switch) preserves it.
            formDraft = EMPTY_FORM;
            onCancel();
          }}
        >
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
        {discovered.length === 0 && !manualUrl ? (
          <Pressable
            style={[styles.btn, { backgroundColor: accentColor }]}
            onPress={handleDiscover}
            disabled={discovering}
          >
            <Text style={styles.btnPrimaryText}>
              {discovering ? "Searching…" : "Find calendars"}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.btn, { backgroundColor: accentColor }]}
            onPress={handleAdd}
            disabled={adding}
          >
            <Text style={styles.btnPrimaryText}>{adding ? "Adding…" : "Add calendar"}</Text>
          </Pressable>
        )}
      </View>

      {!manualUrl && discovered.length === 0 && (
        <Pressable onPress={() => setManualUrl(true)} style={{ alignSelf: "flex-end", marginTop: 10 }}>
          <Text style={[styles.manualLink, { color: accentColor }]}>
            Enter a calendar URL manually instead
          </Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CalDavSettings({ accentColor }: { accentColor: string }) {
  const [sources, setSources] = useState<CalDavSource[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  // Seeded from the module-level flag so a category switch mid-form comes
  // back to the open form (with its surviving draft) rather than the list.
  const [showAdd, setShowAdd] = useState(formDraftOpen);
  useEffect(() => {
    formDraftOpen = showAdd;
  }, [showAdd]);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [srcs, evs] = await Promise.all([
        listCalDavSources(),
        listCalendarEvents(),
      ]);
      setSources(srcs);
      setEvents(evs);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleSync = async (id: number) => {
    setError(null);
    setSyncingId(id);
    try {
      await syncCalDav(id);
      await loadAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    setError(null);
    try {
      await deleteCalDavSource(id);
      await loadAll();
      // The sidebar's calendar list and any open calendar tab watch the
      // bus -- removal here (the only place it lives now; the sidebar's
      // per-row × was retired as too easy to misclick) must reach them.
      emitCalendarBus("sources-changed");
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAdded = async (src: CalDavSource) => {
    setShowAdd(false);
    setSources((prev) => [...prev, src]);
    await loadAll();
  };

  // Show only upcoming events (next 90 days).
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 90);
  const upcoming = events.filter((ev) => {
    const iso = icalToIso(ev.dtstart);
    if (!iso) return false;
    const d = new Date(iso);
    return d >= now && d <= cutoff;
  });

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.heading}>CalDAV calendars</Text>
      <Text style={styles.subheading}>
        Connect CalDAV calendars. Events are cached locally and synced on
        demand.
      </Text>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {sources.length === 0 && !showAdd && (
        <Text style={styles.emptyText}>No calendars connected yet.</Text>
      )}

      {sources.map((src) => (
        <SourceRow
          key={src.id}
          source={src}
          syncing={syncingId === src.id}
          onSync={() => handleSync(src.id)}
          onDelete={() => handleDelete(src.id)}
        />
      ))}

      {showAdd ? (
        <AddSourceForm accentColor={accentColor} onAdded={handleAdded} onCancel={() => setShowAdd(false)} />
      ) : (
        <Pressable
          style={[styles.btn, { backgroundColor: accentColor, alignSelf: "flex-start" }]}
          onPress={() => setShowAdd(true)}
        >
          <Text style={styles.btnPrimaryText}>+ Add calendar</Text>
        </Pressable>
      )}

      {upcoming.length > 0 && (
        <>
          <Text style={[styles.sectionLabel, { marginTop: 28 }]}>
            Upcoming (next 90 days)
          </Text>
          {upcoming
            .sort((a, b) => (a.dtstart ?? "").localeCompare(b.dtstart ?? ""))
            .slice(0, 50)
            .map((ev) => (
              <EventRow key={ev.id} event={ev} accentColor={accentColor} />
            ))}
        </>
      )}

      {events.length > 0 && upcoming.length === 0 && (
        <Text style={styles.emptyText}>
          No upcoming events in the next 90 days.
        </Text>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  heading: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    fontWeight: "700",
    color: colors.text.primary,
    marginBottom: 6,
  },
  subheading: {
    fontFamily: fontFamily.ui,
    fontSize: 13,
    color: colors.text.muted,
    marginBottom: 20,
    lineHeight: 19,
  },
  sectionLabel: {
    fontFamily: fontFamily.ui,
    fontSize: 12,
    fontWeight: "600",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  emptyText: {
    fontFamily: fontFamily.ui,
    fontSize: 13,
    color: colors.text.muted,
    marginBottom: 16,
  },
  hintText: {
    fontFamily: fontFamily.ui,
    fontSize: 12,
    color: colors.text.muted,
    lineHeight: 17,
    marginBottom: 4,
  },
  manualLink: {
    fontFamily: fontFamily.ui,
    fontSize: 12,
    fontWeight: "600",
  },
  card: {
    backgroundColor: colors.background.surface,
    borderRadius: 10,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  sourceRow: {
    backgroundColor: colors.background.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  sourceName: {
    fontFamily: fontFamily.ui,
    fontSize: 14,
    fontWeight: "600",
    color: colors.text.primary,
    marginBottom: 2,
  },
  sourceMeta: { fontFamily: fontFamily.mono, fontSize: 11, color: colors.text.muted, marginBottom: 2 },
  sourceSynced: { fontFamily: fontFamily.ui, fontSize: 11, color: colors.text.muted },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
    gap: 10,
  },
  eventDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  eventTitle: { fontFamily: fontFamily.ui, fontSize: 13, fontWeight: "500", color: colors.text.primary, marginBottom: 2 },
  eventMeta: { fontFamily: fontFamily.mono, fontSize: 11, color: colors.text.muted },
  fieldLabel: {
    fontFamily: fontFamily.ui,
    fontSize: 12,
    color: colors.text.muted,
    marginBottom: 4,
    marginTop: 10,
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.1)",
  },
  discoveredRow: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.04)",
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  discoveredName: { fontFamily: fontFamily.ui, fontSize: 13, fontWeight: "600", color: colors.text.primary },
  discoveredUrl: { fontFamily: fontFamily.mono, fontSize: 10, color: colors.text.muted, marginTop: 2 },
  formBtns: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
    justifyContent: "flex-end",
  },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  // Primary (accent-filled) buttons get their backgroundColor inline from
  // the accentColor prop -- same convention as every other filled button in
  // the app -- with dark text for contrast against any cycle color.
  btnSecondary: { backgroundColor: "rgba(255,255,255,0.1)" },
  btnDanger: { backgroundColor: "rgba(220,80,80,0.3)" },
  btnText: { fontFamily: fontFamily.ui, fontSize: 13, fontWeight: "600", color: colors.text.primary },
  btnPrimaryText: { fontFamily: fontFamily.ui, fontSize: 13, fontWeight: "700", color: colors.background.base },
  errorBanner: {
    backgroundColor: "rgba(220,80,80,0.15)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  errorText: { fontFamily: fontFamily.ui, fontSize: 13, color: "#f87171" },
});
