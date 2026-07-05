import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  addCalDavSource,
  createEvent,
  discoverCalDav,
  icalToIso,
  listCalDavSources,
  listCalendarEvents,
  syncCalDav,
  toIcalDate,
  type CalDavDiscoveredCalendar,
  type CalDavSource,
  type CalendarEvent,
} from "../lib/caldav";
import { emitCalendarBus, onCalendarBus } from "../lib/calendarBus";
import type { HoverState } from "../lib/pressable";
import { colors, fontFamily, fontSize, radii, spacing, withAlpha } from "../theme";
import { Dropdown } from "./Dropdown";

interface CalendarViewProps {
  accentColor: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Repeat choices map straight to RFC 5545 RRULE FREQ values; "custom"
// exposes a raw RRULE input for anything beyond a simple frequency.
const REPEAT_OPTIONS = [
  { key: "none", label: "Does not repeat" },
  { key: "daily", label: "Every day" },
  { key: "weekly", label: "Every week" },
  { key: "monthly", label: "Every month" },
  { key: "yearly", label: "Every year" },
  { key: "custom", label: "Custom" },
];

// Reminder presets in minutes-before-start (the unit create_event's VALARM
// uses); "custom" opens a number + unit pair.
const REMINDER_OPTIONS = [
  { key: "none", label: "No reminder", minutes: 0 },
  { key: "10m", label: "10 min before", minutes: 10 },
  { key: "1h", label: "1 hour before", minutes: 60 },
  { key: "1d", label: "1 day before", minutes: 1440 },
  { key: "1w", label: "1 week before", minutes: 10080 },
  { key: "1M", label: "1 month before", minutes: 43200 },
  { key: "custom", label: "Custom", minutes: -1 },
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function firstWeekdayOf(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7; // Mon-based: 0 = Mon, 6 = Sun
}

function isoDateOf(dtstart: string | null): string | null {
  return icalToIso(dtstart)?.slice(0, 10) ?? null; // "YYYY-MM-DD"
}

// Maps raw connection errors to plain-English explanations a non-technical
// user can act on.
function friendlyError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("401") || r.includes("unauthorized") || r.includes("authentication"))
    return "Wrong username or password. Double-check your credentials and try again.";
  if (r.includes("403") || r.includes("forbidden"))
    return "Access denied. Make sure this account has CalDAV access enabled.";
  if (r.includes("404") || r.includes("not found"))
    return "Calendar URL not found. Check the URL — it should point to your CalDAV calendar, not just the server.";
  if (r.includes("timeout") || r.includes("timed out"))
    return "Connection timed out. Check your internet connection and try again.";
  if (r.includes("dns") || r.includes("resolve") || r.includes("no such host"))
    return "Can't reach that server. Check the URL for typos.";
  if (r.includes("ssl") || r.includes("tls") || r.includes("certificate"))
    return "Secure connection failed. The server's certificate may be invalid.";
  if (r.includes("url") || r.includes("invalid"))
    return "The URL doesn't look right. It should start with https:// and end with a path to your calendar.";
  return "Something went wrong connecting to the calendar. Check your URL and credentials, then try again.";
}

interface FormFieldProps {
  label: string;
  hint: string;
  example: string;
  accentColor: string;
  optional?: boolean;
  children: React.ReactNode;
}

function FormField({ label, hint, example, accentColor, optional, children }: FormFieldProps) {
  return (
    <View style={fieldStyles.wrap}>
      <View style={fieldStyles.labelRow}>
        <Text style={fieldStyles.label}>{label}</Text>
        {optional && <Text style={fieldStyles.optional}>optional</Text>}
      </View>
      <Text style={fieldStyles.hint}>{hint}</Text>
      <View style={fieldStyles.exampleRow}>
        <Text style={fieldStyles.exampleLabel}>e.g. </Text>
        <Text style={[fieldStyles.example, { color: accentColor }]}>{example}</Text>
      </View>
      {children}
    </View>
  );
}

// Raw DOM date/time inputs (RN has no native picker on web); styled to
// match addInput, rendered dark by the global color-scheme.
const taskInputStyle: React.CSSProperties = {
  background: colors.background.surface,
  border: `1px solid ${colors.border.subtle}`,
  borderRadius: radii.md,
  color: colors.text.primary,
  fontFamily: fontFamily.ui,
  fontSize: 13,
  padding: "10px 12px",
  outline: "none",
};

const fieldStyles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.xl,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
    marginBottom: 4,
  },
  label: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  optional: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  hint: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginBottom: 4,
    lineHeight: 16,
  },
  exampleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  exampleLabel: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
  },
  example: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    opacity: 0.8,
  },
});

// In-progress add-calendar form, kept at module level so switching to
// another in-app tab (which unmounts this component) doesn't throw away
// what the user has typed. Cleared when the calendar is added or the form
// is explicitly left via Back/Cancel. Deliberately in-memory only, never
// localStorage/usePersistedState -- it holds a password.
let addFormDraft = { open: false, server: "", url: "", user: "", pass: "", name: "" };

export function CalendarView({ accentColor }: CalendarViewProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState<number | null>(null);

  const [sources, setSources] = useState<CalDavSource[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Add-calendar form state -- seeded from the surviving draft on mount.
  const [showAdd, setShowAdd] = useState(addFormDraft.open);
  const [addServer, setAddServer] = useState(addFormDraft.server);
  const [addUrl, setAddUrl] = useState(addFormDraft.url);
  const [addUser, setAddUser] = useState(addFormDraft.user);
  const [addPass, setAddPass] = useState(addFormDraft.pass);
  const [addName, setAddName] = useState(addFormDraft.name);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  // Calendars the server reported when discovery found more than one --
  // rendered as a pick list so the user chooses before connecting.
  const [discovered, setDiscovered] = useState<CalDavDiscoveredCalendar[]>([]);

  // Add-task (new event) form state -- opened from the header's "+ Add
  // task", creating a real CalDAV event via create_event (with optional
  // RRULE repeat and VALARM reminder).
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState(""); // "YYYY-MM-DD"
  const [taskStart, setTaskStart] = useState("09:00");
  const [taskEnd, setTaskEnd] = useState("10:00");
  const [taskLocation, setTaskLocation] = useState("");
  const [taskSourceId, setTaskSourceId] = useState<number | null>(null);
  const [taskRepeat, setTaskRepeat] = useState("none");
  const [taskCustomRrule, setTaskCustomRrule] = useState("");
  const [taskReminder, setTaskReminder] = useState("none");
  const [taskCustomReminderValue, setTaskCustomReminderValue] = useState("30");
  const [taskCustomReminderUnit, setTaskCustomReminderUnit] = useState("minutes");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);

  // Mirror every change back into the draft so the latest keystrokes are
  // what a remounted instance picks up.
  useEffect(() => {
    addFormDraft = { open: showAdd, server: addServer, url: addUrl, user: addUser, pass: addPass, name: addName };
  }, [showAdd, addServer, addUrl, addUser, addPass, addName]);

  // Leaving the form on purpose (Back/Cancel) or completing it discards the
  // draft; only an unmount mid-typing preserves it.
  function closeAddForm() {
    setShowAdd(false);
    setAddServer(""); setAddUrl(""); setAddUser(""); setAddPass(""); setAddName("");
    setDiscovered([]);
    setAddError(null);
  }

  // The sidebar hosts the "Add calendar" action while a calendar tab is
  // open; it signals over the bus and this view opens its add form. The
  // sidebar also lists/removes sources, so source changes from either side
  // are announced on the bus and reloaded here.
  useEffect(() => onCalendarBus("open-add-calendar", () => { setShowAddTask(false); setShowAdd(true); }), []);
  useEffect(() => onCalendarBus("sources-changed", () => { loadSources(); }), []);

  useEffect(() => {
    loadSources();
  }, []);

  useEffect(() => {
    if (sources.length > 0) loadEvents();
  }, [sources, year, month]);

  async function loadSources() {
    setLoading(true);
    try {
      const list = await listCalDavSources();
      setSources(list);
      setLoadError(null);
    } catch (e) {
      // Keep whatever sources we already had: a backend hiccup (locked
      // keychain, cache not reachable yet) must not present as "your
      // calendars are gone" -- that reads like deleted credentials.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadEvents() {
    // Upper bound is exclusive (first of next month) so timed events on the
    // last day of the month still compare "<=" against it as strings.
    const from = toIcalDate(new Date(year, month, 1));
    const to = toIcalDate(new Date(year, month + 1, 1));
    try {
      const list = await listCalendarEvents({ fromDate: from, toDate: to });
      setEvents(list);
    } catch {
      setEvents([]);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await Promise.all(sources.map((s) => syncCalDav(s.id)));
      await loadEvents();
    } finally {
      setSyncing(false);
    }
  }

  // add_caldav_source performs the initial sync itself (and rolls back on
  // failure), so the calendar arrives fully populated -- no separate sync
  // call needed after it.
  async function connectCalendar(url: string, displayName: string) {
    await addCalDavSource({
      accountId: addUser,
      url,
      username: addUser.trim(),
      password: addPass,
      displayName: displayName.trim() || undefined,
    });
    closeAddForm();
    await loadSources();
    emitCalendarBus("sources-changed");
  }

  // One button does the whole job: a typed URL is used as-is; an empty URL
  // is discovered from the (required) server address -- connecting straight
  // away when the server has exactly one calendar, or showing a pick list
  // when it has several.
  async function handleAddCalendar() {
    if (!addUser.trim() || !addPass) {
      setAddError("Username and password are required.");
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      if (addUrl.trim()) {
        await connectCalendar(addUrl.trim(), addName);
        return;
      }
      if (!addServer.trim()) {
        setAddError("Enter your server address (or a full calendar URL below).");
        return;
      }
      const cals = await discoverCalDav({
        host: addServer.trim(),
        username: addUser.trim(),
        password: addPass,
      });
      if (cals.length === 0) {
        setAddError("No calendars found on that server. If you know the calendar URL, enter it below.");
      } else if (cals.length === 1) {
        await connectCalendar(cals[0].url, addName || (cals[0].display_name ?? ""));
      } else {
        setDiscovered(cals);
        setAddUrl(cals[0].url);
        if (!addName) setAddName(cals[0].display_name ?? "");
      }
    } catch (e) {
      // friendlyError only here, on raw transport/server errors -- the
      // validation messages set above are already user-facing text.
      setAddError(friendlyError(e instanceof Error ? e.message : String(e)));
    } finally {
      setAddSaving(false);
    }
  }

  function openAddTask() {
    const fallback = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    setTaskDate(selectedDateKey ?? fallback);
    if (taskSourceId === null && sources[0]) setTaskSourceId(sources[0].id);
    setShowAdd(false);
    setShowAddTask(true);
  }

  function closeAddTask() {
    setShowAddTask(false);
    setTaskTitle(""); setTaskLocation("");
    setTaskRepeat("none"); setTaskCustomRrule("");
    setTaskReminder("none");
    setTaskError(null);
  }

  // Local wall-clock date+time → the compact UTC form ("20260702T090000Z")
  // build_vcalendar emits verbatim.
  function toCompactUtc(local: Date): string {
    return local.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
  }

  async function handleCreateTask() {
    if (!taskTitle.trim()) { setTaskError("Give the event a title."); return; }
    if (taskSourceId === null) { setTaskError("Connect a calendar first."); return; }
    if (!taskDate || !taskStart) { setTaskError("Pick a date and start time."); return; }
    const start = new Date(`${taskDate}T${taskStart}`);
    const end = taskEnd ? new Date(`${taskDate}T${taskEnd}`) : new Date(start.getTime() + 3600000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setTaskError("That date or time doesn't parse.");
      return;
    }
    if (end.getTime() <= start.getTime()) { setTaskError("End time must be after the start time."); return; }

    const rrule =
      taskRepeat === "none"
        ? undefined
        : taskRepeat === "custom"
          ? taskCustomRrule.trim() || undefined
          : `FREQ=${{ daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[taskRepeat]}`;

    let reminderMinutesBefore: number | undefined;
    if (taskReminder === "custom") {
      const value = Number(taskCustomReminderValue);
      if (!Number.isFinite(value) || value <= 0) { setTaskError("The custom reminder needs a positive number."); return; }
      const unitMinutes = taskCustomReminderUnit === "days" ? 1440 : taskCustomReminderUnit === "hours" ? 60 : 1;
      reminderMinutesBefore = Math.round(value * unitMinutes);
    } else if (taskReminder !== "none") {
      reminderMinutesBefore = REMINDER_OPTIONS.find((option) => option.key === taskReminder)?.minutes;
    }

    setTaskSaving(true);
    setTaskError(null);
    try {
      await createEvent({
        sourceId: taskSourceId,
        summary: taskTitle.trim(),
        dtstart: toCompactUtc(start),
        dtend: toCompactUtc(end),
        location: taskLocation.trim() || undefined,
        rrule,
        reminderMinutesBefore,
      });
      closeAddTask();
      await loadEvents();
    } catch (e) {
      setTaskError(friendlyError(e instanceof Error ? e.message : String(e)));
    } finally {
      setTaskSaving(false);
    }
  }

  function prevMonth() {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
    setSelected(null);
  }

  function nextMonth() {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
    setSelected(null);
  }

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const startOffset = firstWeekdayOf(year, month);

  const cells: Array<number | null> = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  // Events keyed by "YYYY-MM-DD"
  const eventsByDay: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    const key = isoDateOf(ev.dtstart);
    if (!key) continue;
    if (!eventsByDay[key]) eventsByDay[key] = [];
    eventsByDay[key].push(ev);
  }

  const selectedDateKey = selected !== null
    ? `${year}-${String(month + 1).padStart(2, "0")}-${String(selected).padStart(2, "0")}`
    : null;
  const selectedEvents = selectedDateKey ? (eventsByDay[selectedDateKey] ?? []) : [];

  // ── Load failure: connected calendars couldn't be listed ──
  // Distinct from the "nothing connected yet" empty state below: sources
  // still exist in the encrypted cache, this session just failed to read
  // them, so offer a retry instead of the connect-a-calendar pitch.
  if (!loading && loadError && sources.length === 0 && !showAdd) {
    return (
      <View style={styles.pane}>
        <View style={styles.emptyOuter}>
          <Text style={styles.emptyHeadline}>Couldn't load your calendars</Text>
          <Text style={styles.emptySubtext}>
            Your connected calendars are still saved, but reading them failed:{" "}
            {loadError}
          </Text>
          <Pressable
            onPress={() => loadSources()}
            style={({ hovered }: HoverState) => [
              styles.connectBtn,
              { marginTop: 8, backgroundColor: accentColor, shadowColor: accentColor },
              hovered && { opacity: 0.88 },
            ]}
          >
            <Text style={styles.connectBtnText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Empty state: no sources connected ──
  if (!loading && sources.length === 0 && !showAdd) {
    return (
      <View style={styles.pane}>
        <View style={styles.emptyOuter}>
          <View style={[styles.emptyIconWrap, { backgroundColor: withAlpha(accentColor, 0.12) }]}>
            <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </View>
          <Text style={styles.emptyHeadline}>No calendar connected</Text>
          <Text style={styles.emptySubtext}>
            See your events alongside your mail by connecting a calendar account.
          </Text>

          <View style={[styles.infoCard, { borderColor: withAlpha(accentColor, 0.25) }]}>
            <Text style={[styles.infoTitle, { color: accentColor }]}>What's CalDAV?</Text>
            <Text style={styles.infoBody}>
              CalDAV is the open standard most calendar providers already speak under
              the hood. Connecting it lets Helix read and sync your events directly
              with the server -- no separate calendar app, and no data going through
              a third party.
            </Text>
            <Text style={styles.infoBody}>
              Works with iCloud, Fastmail, Nextcloud, Radicale, and any other standard
              CalDAV server. You'll need the calendar's CalDAV URL plus your username
              and password (or an app-specific password) -- your provider's account
              settings will have these.
            </Text>
          </View>

          {/* "Add a calendar" here, "Connect calendar" on the form's submit --
              two different actions, so they don't share a label (and the two
              pages stop looking like the same screen twice). */}
          <Pressable
            onPress={() => setShowAdd(true)}
            style={({ hovered }: HoverState) => [
              styles.connectBtn,
              { marginTop: 8, backgroundColor: accentColor, shadowColor: accentColor },
              hovered && { opacity: 0.88 },
            ]}
          >
            <Text style={styles.connectBtnText}>Add a calendar</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Add calendar form ──
  if (showAdd) {
    return (
      <View style={styles.pane}>
        <ScrollView contentContainerStyle={styles.addFormOuter}>
          <View style={styles.addForm}>
            {/* Back */}
            <Pressable onPress={closeAddForm} style={styles.addBack}>
              <Text style={[styles.addBackText, { color: accentColor }]}>‹ Back</Text>
            </Pressable>

            <Text style={[styles.addEyebrow, { color: accentColor }]}>Add a calendar</Text>
            <Text style={styles.addTitle}>Connect a CalDAV calendar</Text>
            <Text style={styles.addSubtitle}>
              Enter your server and sign-in details — Helix finds the calendars itself.
              Works with iCloud, Fastmail, Nextcloud, Radicale, and any standard CalDAV server.
            </Text>

            <FormField
              label="Username"
              hint="Usually your email address or account login"
              example="you@example.com"
              accentColor={accentColor}
            >
              <TextInput
                style={styles.addInput}
                value={addUser}
                onChangeText={(t) => { setAddUser(t); setAddError(null); }}
                placeholder="you@example.com"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </FormField>

            <FormField
              label="Password"
              hint="Use an app-specific password if your provider supports two-factor auth"
              example="app-specific or account password"
              accentColor={accentColor}
            >
              <TextInput
                style={styles.addInput}
                value={addPass}
                onChangeText={(t) => { setAddPass(t); setAddError(null); }}
                placeholder="Password or app-specific password"
                placeholderTextColor={colors.text.muted}
                secureTextEntry
              />
            </FormField>

            <FormField
              label="Server"
              hint="Just the server address — Helix finds the calendar path itself."
              example="mail.example.com:2080"
              accentColor={accentColor}
            >
              <TextInput
                style={styles.addInput}
                value={addServer}
                onChangeText={(t) => { setAddServer(t); setAddError(null); }}
                placeholder={addUser.includes("@") ? addUser.split("@")[1] : "caldav.example.com"}
                placeholderTextColor={colors.text.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </FormField>

            {discovered.length > 0 && (
              <FormField
                label="Calendar"
                hint={`Found ${discovered.length} calendars on ${addServer.trim()} — pick one`}
                example={discovered[0].display_name ?? discovered[0].url}
                accentColor={accentColor}
              >
                <View>
                  {discovered.map((cal) => {
                    const active = addUrl === cal.url;
                    return (
                      <Pressable
                        key={cal.url}
                        onPress={() => {
                          setAddUrl(cal.url);
                          setAddName(cal.display_name ?? "");
                        }}
                        style={[
                          styles.calPickRow,
                          active && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.12) },
                        ]}
                      >
                        <Text style={styles.calPickName}>{cal.display_name ?? "(unnamed calendar)"}</Text>
                        <Text style={styles.calPickUrl} numberOfLines={1}>{cal.url}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </FormField>
            )}

            {discovered.length === 0 && (
              <FormField
                label="Calendar URL"
                hint="Only needed if automatic discovery doesn't work on your server — a typed URL is used as-is."
                example="https://caldav.fastmail.com/dav/calendars/user/you@example.com/"
                accentColor={accentColor}
                optional
              >
                <TextInput
                  style={styles.addInput}
                  value={addUrl}
                  onChangeText={(t) => { setAddUrl(t); setAddError(null); }}
                  placeholder="https://caldav.example.com/calendar/"
                  placeholderTextColor={colors.text.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </FormField>
            )}

            <FormField
              label="Display name"
              hint="How this calendar appears in Helix"
              example="Work Calendar"
              accentColor={accentColor}
              optional
            >
              <TextInput
                style={styles.addInput}
                value={addName}
                onChangeText={setAddName}
                placeholder="My Calendar"
                placeholderTextColor={colors.text.muted}
              />
            </FormField>

            {addError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorIcon}>⚠</Text>
                <View style={styles.errorBody}>
                  <Text style={styles.errorTitle}>Couldn't connect</Text>
                  <Text style={styles.errorDetail}>{addError}</Text>
                </View>
              </View>
            )}

            <View style={styles.addActions}>
              <Pressable
                onPress={closeAddForm}
                style={({ hovered }: HoverState) => [styles.cancelBtn, hovered && styles.cancelBtnHover]}
                disabled={addSaving}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleAddCalendar}
                disabled={addSaving}
                style={({ hovered }: HoverState) => [
                  styles.connectBtn,
                  { backgroundColor: accentColor, shadowColor: accentColor },
                  hovered && { opacity: 0.88 },
                  addSaving && { opacity: 0.55 },
                ]}
              >
                <Text style={styles.connectBtnText}>
                  {addSaving ? "Connecting…" : "Connect calendar"}
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Add task (new event) form ──
  if (showAddTask) {
    return (
      <View style={styles.pane}>
        <ScrollView contentContainerStyle={styles.addFormOuter}>
          <View style={styles.addForm}>
            <Pressable onPress={closeAddTask} style={styles.addBack}>
              <Text style={[styles.addBackText, { color: accentColor }]}>‹ Back</Text>
            </Pressable>

            <Text style={[styles.addEyebrow, { color: accentColor }]}>Add task</Text>
            <Text style={styles.addTitle}>New event</Text>

            <FormField
              label="Title"
              hint="What is this event?"
              example="Team standup"
              accentColor={accentColor}
            >
              <TextInput
                style={styles.addInput}
                value={taskTitle}
                onChangeText={(t) => { setTaskTitle(t); setTaskError(null); }}
                placeholder="Event title"
                placeholderTextColor={colors.text.muted}
              />
            </FormField>

            {sources.length > 1 && (
              <View style={fieldStyles.wrap}>
                <Text style={fieldStyles.label}>Calendar</Text>
                <View style={{ marginTop: 4 }}>
                  <Dropdown
                    value={String(taskSourceId ?? sources[0]?.id ?? "")}
                    options={sources.map((src) => ({
                      value: String(src.id),
                      label: src.display_name || src.username,
                    }))}
                    accentColor={accentColor}
                    width={220}
                    onChange={(value) => setTaskSourceId(Number(value))}
                  />
                </View>
              </View>
            )}

            <View style={fieldStyles.wrap}>
              <Text style={fieldStyles.label}>Date and time</Text>
              <View style={styles.taskTimeRow}>
                <input
                  type="date"
                  value={taskDate}
                  onChange={(e) => { setTaskDate((e.target as HTMLInputElement).value); setTaskError(null); }}
                  style={taskInputStyle}
                />
                <input
                  type="time"
                  value={taskStart}
                  onChange={(e) => { setTaskStart((e.target as HTMLInputElement).value); setTaskError(null); }}
                  style={taskInputStyle}
                />
                <Text style={styles.taskTimeDash}>–</Text>
                <input
                  type="time"
                  value={taskEnd}
                  onChange={(e) => { setTaskEnd((e.target as HTMLInputElement).value); setTaskError(null); }}
                  style={taskInputStyle}
                />
              </View>
            </View>

            <FormField
              label="Location"
              hint="Where it happens"
              example="Meeting room 2 / https://meet.example.com/abc"
              accentColor={accentColor}
              optional
            >
              <TextInput
                style={styles.addInput}
                value={taskLocation}
                onChangeText={setTaskLocation}
                placeholder="Location"
                placeholderTextColor={colors.text.muted}
              />
            </FormField>

            <View style={fieldStyles.wrap}>
              <Text style={fieldStyles.label}>Repeat</Text>
              <View style={styles.taskPillRow}>
                {REPEAT_OPTIONS.map((option) => {
                  const active = taskRepeat === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setTaskRepeat(option.key)}
                      style={[
                        styles.taskPill,
                        active && { backgroundColor: withAlpha(accentColor, 0.18), borderColor: accentColor },
                      ]}
                    >
                      <Text style={[styles.taskPillText, active && { color: accentColor }]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {taskRepeat === "custom" && (
                <TextInput
                  style={[styles.addInput, { marginTop: spacing.sm }]}
                  value={taskCustomRrule}
                  onChangeText={setTaskCustomRrule}
                  placeholder="RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR"
                  placeholderTextColor={colors.text.muted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              )}
            </View>

            <View style={fieldStyles.wrap}>
              <Text style={fieldStyles.label}>Reminder</Text>
              <View style={styles.taskPillRow}>
                {REMINDER_OPTIONS.map((option) => {
                  const active = taskReminder === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setTaskReminder(option.key)}
                      style={[
                        styles.taskPill,
                        active && { backgroundColor: withAlpha(accentColor, 0.18), borderColor: accentColor },
                      ]}
                    >
                      <Text style={[styles.taskPillText, active && { color: accentColor }]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {taskReminder === "custom" && (
                <View style={[styles.taskTimeRow, { marginTop: spacing.sm }]}>
                  <TextInput
                    style={[styles.addInput, { width: 90 }]}
                    value={taskCustomReminderValue}
                    onChangeText={setTaskCustomReminderValue}
                    placeholder="30"
                    placeholderTextColor={colors.text.muted}
                    keyboardType="numeric"
                  />
                  <Dropdown
                    value={taskCustomReminderUnit}
                    options={[
                      { value: "minutes", label: "minutes" },
                      { value: "hours", label: "hours" },
                      { value: "days", label: "days" },
                    ]}
                    accentColor={accentColor}
                    width={110}
                    onChange={setTaskCustomReminderUnit}
                  />
                  <Text style={styles.taskTimeDash}>before</Text>
                </View>
              )}
            </View>

            {taskError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorIcon}>⚠</Text>
                <View style={styles.errorBody}>
                  <Text style={styles.errorTitle}>Can't add that yet</Text>
                  <Text style={styles.errorDetail}>{taskError}</Text>
                </View>
              </View>
            )}

            <View style={styles.addActions}>
              <Pressable
                onPress={closeAddTask}
                style={({ hovered }: HoverState) => [styles.cancelBtn, hovered && styles.cancelBtnHover]}
                disabled={taskSaving}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleCreateTask}
                disabled={taskSaving}
                style={({ hovered }: HoverState) => [
                  styles.connectBtn,
                  { backgroundColor: accentColor, shadowColor: accentColor },
                  hovered && { opacity: 0.88 },
                  taskSaving && { opacity: 0.55 },
                ]}
              >
                <Text style={styles.connectBtnText}>{taskSaving ? "Adding…" : "Add task"}</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Full calendar view ──
  return (
    <View style={styles.pane}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.nav}>
          <Pressable
            onPress={prevMonth}
            style={({ hovered }: HoverState) => [styles.navBtn, hovered && { backgroundColor: withAlpha(accentColor, 0.15) }]}
          >
            <Text style={[styles.navArrow, { color: accentColor }]}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{MONTHS[month]} {year}</Text>
          <Pressable
            onPress={nextMonth}
            style={({ hovered }: HoverState) => [styles.navBtn, hovered && { backgroundColor: withAlpha(accentColor, 0.15) }]}
          >
            <Text style={[styles.navArrow, { color: accentColor }]}>›</Text>
          </Pressable>
          {!isCurrentMonth && (
            <Pressable
              onPress={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); setSelected(today.getDate()); }}
              style={({ hovered }: HoverState) => [
                styles.todayBtn,
                { borderColor: withAlpha(accentColor, 0.5) },
                hovered && { backgroundColor: withAlpha(accentColor, 0.12) },
              ]}
            >
              <Text style={[styles.todayBtnText, { color: accentColor }]}>Today</Text>
            </Pressable>
          )}
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={handleSync}
            disabled={syncing}
            style={({ hovered }: HoverState) => [styles.syncBtn, hovered && { backgroundColor: withAlpha(accentColor, 0.12) }]}
          >
            <Text style={[styles.syncBtnText, { color: accentColor }, syncing && { opacity: 0.5 }]}>
              {syncing ? "Syncing…" : "↻ Sync"}
            </Text>
          </Pressable>
          <Pressable
            onPress={openAddTask}
            style={({ hovered }: HoverState) => [styles.syncBtn, hovered && { backgroundColor: withAlpha(accentColor, 0.12) }]}
          >
            <Text style={[styles.syncBtnText, { color: accentColor }]}>+ Add task</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.body}>
        {/* The calendar list itself lives in the app sidebar while a
            calendar tab is open (see Sidebar's calendar section + the
            calendar bus) -- no second sidebar here. */}
        {/* Grid */}
        <ScrollView style={styles.gridScroll} contentContainerStyle={styles.gridContent}>
          {/* Weekday labels */}
          <View style={styles.weekRow}>
            {WEEKDAYS.map((d) => (
              <View key={d} style={styles.weekCell}>
                <Text style={styles.weekLabel}>{d}</Text>
              </View>
            ))}
          </View>
          {/* Day cells */}
          <View style={styles.grid}>
            {cells.map((day, idx) => {
              const isToday = isCurrentMonth && day === today.getDate();
              const isSelected = day === selected;
              const isWeekend = idx % 7 >= 5;
              const dateKey = day !== null
                ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                : null;
              const dayEvents = dateKey ? (eventsByDay[dateKey] ?? []) : [];
              return (
                <Pressable
                  key={idx}
                  disabled={day === null}
                  onPress={() => setSelected(day === selected ? null : day)}
                  style={({ hovered }: HoverState) => [
                    styles.dayCell,
                    day === null && styles.dayCellEmpty,
                    isWeekend && day !== null && styles.dayCellWeekend,
                    hovered && day !== null && { backgroundColor: withAlpha(accentColor, 0.08) },
                    isSelected && { backgroundColor: withAlpha(accentColor, 0.18), borderColor: withAlpha(accentColor, 0.4) },
                  ]}
                >
                  {day !== null && (
                    <>
                      <View style={[styles.dayNum, isToday && { backgroundColor: accentColor }]}>
                        <Text style={[
                          styles.dayNumText,
                          isToday && styles.dayNumTextToday,
                          isWeekend && !isToday && { color: colors.text.muted },
                        ]}>
                          {day}
                        </Text>
                      </View>
                      {dayEvents.slice(0, 3).map((ev, i) => (
                        <View key={ev.id} style={[styles.eventChip, { backgroundColor: withAlpha(accentColor, 0.25) }]}>
                          <Text style={[styles.eventChipText, { color: accentColor }]} numberOfLines={1}>
                            {ev.summary ?? "Event"}
                          </Text>
                        </View>
                      ))}
                      {dayEvents.length > 3 && (
                        <Text style={[styles.moreEvents, { color: accentColor }]}>+{dayEvents.length - 3} more</Text>
                      )}
                    </>
                  )}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* Selected day detail */}
        {selected !== null && (
          <View style={styles.detail}>
            <Text style={[styles.detailTitle, { color: accentColor }]}>
              {MONTHS[month]} {selected}
            </Text>
            {selectedEvents.length === 0 ? (
              <Text style={styles.detailEmpty}>No events.</Text>
            ) : (
              <ScrollView>
                {selectedEvents.map((ev) => (
                  <View key={ev.id} style={[styles.detailEvent, { borderLeftColor: accentColor }]}>
                    <Text style={styles.detailEventTitle}>{ev.summary ?? "Untitled"}</Text>
                    {ev.dtstart && (
                      <Text style={styles.detailEventTime}>
                        {new Date(icalToIso(ev.dtstart)!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {ev.dtend ? ` – ${new Date(icalToIso(ev.dtend)!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                      </Text>
                    )}
                    {ev.location && <Text style={styles.detailEventMeta}>{ev.location}</Text>}
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    backgroundColor: colors.background.base,
    flexDirection: "column",
  },

  // ── Empty / add form ──
  emptyOuter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 48,
  },
  infoCard: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.background.surface,
  },
  infoTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
  infoBody: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    lineHeight: 17,
    textAlign: "left",
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyHeadline: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "600",
    color: colors.text.primary,
  },
  emptySubtext: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    textAlign: "center",
    maxWidth: 300,
  },
  // No marginTop here: this style is shared between the empty state's
  // standalone CTA (which adds its own spacing inline) and the form action
  // rows, where an offset would knock the button out of line with Cancel.
  connectBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.pill,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  connectBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.background.base,
  },

  addFormOuter: {
    alignItems: "center",
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    minHeight: "100%",
  },
  addForm: {
    width: "100%",
    maxWidth: 480,
    paddingTop: spacing.md,
  },
  addBack: {
    alignSelf: "flex-start",
    marginBottom: spacing.xl,
  },
  addBackText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  // Accent eyebrow above the form title -- marks this page as the add
  // *step*, visually distinct from the "no calendar connected" empty state
  // that links to it.
  addEyebrow: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: spacing.xs,
  },
  addTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "700",
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  addSubtitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
    lineHeight: 20,
    marginBottom: spacing.xxl,
  },
  addInput: {
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text.primary,
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
  },
  // Discovered-calendar picker rows -- the selected one takes the accent
  // border/tint inline, matching the discovered-list in CalDavSettings.
  calPickRow: {
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
  },
  calPickName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  calPickUrl: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    color: colors.text.muted,
    marginTop: 2,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: "rgba(239,68,68,0.08)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.25)",
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorIcon: {
    fontSize: 14,
    color: "#EF4444",
    marginTop: 1,
  },
  errorBody: {
    flex: 1,
  },
  errorTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: "#EF4444",
    marginBottom: 3,
  },
  errorDetail: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  addActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  cancelBtn: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "transparent",
  },
  cancelBtnHover: {
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  cancelBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.muted,
  },

  // ── Calendar header ──
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  navArrow: {
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 26,
  },
  monthLabel: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: "600",
    color: colors.text.primary,
    minWidth: 190,
    textAlign: "center",
  },
  todayBtn: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    marginLeft: spacing.sm,
  },
  todayBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  syncBtn: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  syncBtnText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },

  // ── Body (grid + detail side by side) ──
  body: {
    flex: 1,
    flexDirection: "row",
  },
  gridScroll: {
    flex: 1,
  },
  gridContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  weekRow: {
    flexDirection: "row",
    marginBottom: spacing.xs,
  },
  weekCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  weekLabel: {
    fontFamily: fontFamily.ui,
    fontSize: 11,
    fontWeight: "700",
    color: colors.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayCell: {
    width: `${100 / 7}%`,
    minHeight: 90,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    borderRadius: radii.sm,
    padding: spacing.xs,
    marginBottom: 3,
  },
  dayCellEmpty: {
    opacity: 0,
    pointerEvents: "none",
  } as never,
  dayCellWeekend: {
    backgroundColor: "rgba(255,255,255,0.015)",
  },
  dayNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 3,
  },
  dayNumText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "500",
    color: colors.text.secondary,
  },
  dayNumTextToday: {
    color: colors.background.base,
    fontWeight: "700",
  },
  eventChip: {
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginBottom: 2,
  },
  eventChipText: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "600",
  },
  moreEvents: {
    fontFamily: fontFamily.ui,
    fontSize: 10,
    fontWeight: "600",
    marginTop: 1,
  },

  // ── Selected day detail panel ──
  detail: {
    width: 240,
    borderLeftWidth: 1,
    borderLeftColor: colors.border.subtle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  detailTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    fontWeight: "600",
    marginBottom: spacing.md,
  },
  detailEmpty: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
  },
  detailEvent: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    marginBottom: spacing.md,
  },
  detailEventTitle: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  detailEventTime: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginTop: 2,
  },
  detailEventMeta: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginTop: 2,
  },
  // ── Add-task form extras ──
  taskTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 4,
  },
  taskTimeDash: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    color: colors.text.muted,
  },
  taskPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: 4,
  },
  taskPill: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  taskPillText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.text.secondary,
  },
});
