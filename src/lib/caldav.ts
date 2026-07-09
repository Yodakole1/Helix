import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";

export interface CalDavSource {
  id: number;
  account_id: string;
  url: string;
  display_name: string | null;
  username: string;
  color: string | null;
  last_synced_at: string | null;
}

export interface CalDavSyncResult {
  events_added: number;
  events_updated: number;
  events_deleted: number;
}

export interface CalDavDiscoveredCalendar {
  url: string;
  display_name: string | null;
}

/**
 * Normalizes a `dtstart`/`dtend` value into ISO 8601. CalDAV servers return
 * these in RFC 5545's compact iCal format ("20260701T100000Z" or, for
 * all-day events, "20260701") straight from the raw ICS, not ISO — anything
 * that hands these to `new Date(...)` or slices them assuming hyphens needs
 * to go through this first. Already-ISO input passes through unchanged.
 */
export function icalToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return raw;
  const [, y, mo, d, h, mi, s, z] = m;
  return h ? `${y}-${mo}-${d}T${h}:${mi}:${s}${z ?? ""}` : `${y}-${mo}-${d}`;
}

/** Formats a local calendar date as iCal-compact ("YYYYMMDD"), matching the
 * format `list_calendar_events`'s `from_date`/`to_date` filters expect. */
export function toIcalDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${mo}${day}`;
}

export interface CalendarEvent {
  id: number;
  source_id: number;
  uid: string;
  href: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  dtstart: string | null;
  dtend: string | null;
  organizer: string | null;
  status: string | null;
  rrule: string | null;
  synced_at: string;
}

export async function addCalDavSource(args: {
  accountId: string;
  url: string;
  username: string;
  password: string;
  displayName?: string;
  color?: string;
}): Promise<CalDavSource> {
  if (!isTauri()) throw new Error("CalDAV requires the desktop app");
  return invoke("add_caldav_source", {
    accountId: args.accountId,
    url: args.url,
    username: args.username,
    password: args.password,
    displayName: args.displayName ?? null,
    color: args.color ?? null,
  });
}

export async function listCalDavSources(): Promise<CalDavSource[]> {
  if (!isTauri()) return [];
  return invoke("list_caldav_sources");
}

/** Sets (or clears) a calendar's display color -- a purely local preference
 * used to tint its events in the calendar grid. */
export async function updateCalDavSourceColor(id: number, color: string | null): Promise<void> {
  if (!isTauri()) return;
  return invoke("update_caldav_source_color", { id, color });
}

export async function deleteCalDavSource(id: number): Promise<void> {
  if (!isTauri()) return;
  return invoke("delete_caldav_source", { id });
}

export async function syncCalDav(id: number): Promise<CalDavSyncResult> {
  if (!isTauri()) throw new Error("CalDAV requires the desktop app");
  return invoke("sync_caldav", { id });
}

export async function discoverCalDav(args: {
  host: string;
  username: string;
  password: string;
}): Promise<CalDavDiscoveredCalendar[]> {
  if (!isTauri()) return [];
  return invoke("discover_caldav", args);
}

export async function listCalendarEvents(args?: {
  sourceId?: number;
  fromDate?: string;
  toDate?: string;
}): Promise<CalendarEvent[]> {
  if (!isTauri()) return [];
  return invoke("list_calendar_events", {
    sourceId: args?.sourceId ?? null,
    fromDate: args?.fromDate ?? null,
    toDate: args?.toDate ?? null,
  });
}

export async function createEvent(args: {
  sourceId: number;
  summary: string;
  dtstart: string;
  dtend: string;
  location?: string;
  description?: string;
  rrule?: string;
  // Display reminder (RFC 5545 VALARM) this many minutes before dtstart.
  reminderMinutesBefore?: number;
}): Promise<CalendarEvent> {
  if (!isTauri()) throw new Error("CalDAV requires the desktop app");
  return invoke("create_event", {
    sourceId: args.sourceId,
    summary: args.summary,
    dtstart: args.dtstart,
    dtend: args.dtend,
    location: args.location ?? null,
    description: args.description ?? null,
    rrule: args.rrule ?? null,
    reminderMinutesBefore: args.reminderMinutesBefore ?? null,
  });
}

export async function updateEvent(args: {
  sourceId: number;
  uid: string;
  summary: string;
  dtstart: string;
  dtend: string;
  location?: string;
  description?: string;
  rrule?: string;
}): Promise<CalendarEvent> {
  if (!isTauri()) throw new Error("CalDAV requires the desktop app");
  return invoke("update_event", {
    sourceId: args.sourceId,
    uid: args.uid,
    summary: args.summary,
    dtstart: args.dtstart,
    dtend: args.dtend,
    location: args.location ?? null,
    description: args.description ?? null,
    rrule: args.rrule ?? null,
  });
}

export async function deleteEvent(sourceId: number, uid: string): Promise<void> {
  if (!isTauri()) return;
  return invoke("delete_event", { sourceId, uid });
}
