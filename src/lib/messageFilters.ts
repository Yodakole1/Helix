import { calendarDayDiff, type SampleMessage } from "../data/messages";

export type SortKey = "newest" | "oldest" | "unread";
export type DateRange = "any" | "today" | "7days" | "30days" | "custom";

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export interface MessageFilters {
  query: string;
  from: string;
  to: string;
  dateRange: DateRange;
  // "YYYY-MM" -- only meaningful when dateRange === "custom".
  customFrom: string;
  customTo: string;
  // Tri-state filters: null = don't filter, true = only matching, false = only non-matching.
  isUnread: boolean | null;
  isFlagged: boolean | null;
  hasAttachment: boolean | null;
}

export const DEFAULT_FILTERS: MessageFilters = {
  query: "",
  from: "",
  to: "",
  dateRange: "any",
  customFrom: currentYearMonth(),
  customTo: currentYearMonth(),
  isUnread: null,
  isFlagged: null,
  hasAttachment: null,
};

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "unread", label: "Unread first" },
];

export const DATE_RANGE_OPTIONS: { key: DateRange; label: string }[] = [
  { key: "any", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "7days", label: "7 days" },
  { key: "30days", label: "30 days" },
  { key: "custom", label: "Custom" },
];

export const MONTH_OPTIONS: { value: string; label: string }[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
].map((label, index) => ({ value: String(index + 1).padStart(2, "0"), label }));

// 1971 -- Ray Tomlinson's first networked email on ARPANET -- through the
// current year, so the picker can't fail to cover a real message's date.
const EMAIL_INVENTED_YEAR = 1971;

export function yearOptions(): { value: string; label: string }[] {
  const currentYear = new Date().getFullYear();
  const years: { value: string; label: string }[] = [];
  for (let year = currentYear; year >= EMAIL_INVENTED_YEAR; year--) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

function messageYearMonth(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function withinDateRange(iso: string, filters: MessageFilters): boolean {
  if (filters.dateRange === "any") return true;
  if (filters.dateRange === "custom") {
    const yearMonth = messageYearMonth(iso);
    // "YYYY-MM" strings compare correctly lexicographically.
    return yearMonth >= filters.customFrom && yearMonth <= filters.customTo;
  }
  const dayDiff = calendarDayDiff(iso);
  if (dayDiff < 0) return false; // future-dated, not relevant to any preset
  if (filters.dateRange === "today") return dayDiff === 0;
  if (filters.dateRange === "7days") return dayDiff < 7;
  return dayDiff < 30;
}

export function hasActiveFilters(filters: MessageFilters): boolean {
  return (
    filters.query.trim() !== "" ||
    filters.from.trim() !== "" ||
    filters.to.trim() !== "" ||
    filters.dateRange !== "any" ||
    filters.isUnread !== null ||
    filters.isFlagged !== null ||
    filters.hasAttachment !== null
  );
}

export function filterMessages<T extends SampleMessage>(messages: T[], filters: MessageFilters): T[] {
  const query = filters.query.trim().toLowerCase();
  const from = filters.from.trim().toLowerCase();
  const to = filters.to.trim().toLowerCase();

  return messages.filter((message) => {
    if (query) {
      const haystack = `${message.sender} ${message.senderEmail} ${message.subject} ${message.preview}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (from && !`${message.sender} ${message.senderEmail}`.toLowerCase().includes(from)) return false;
    if (to && !message.to.toLowerCase().includes(to)) return false;
    if (!withinDateRange(message.date, filters)) return false;
    if (filters.isUnread !== null && Boolean(message.unread) !== filters.isUnread) return false;
    if (filters.isFlagged !== null && Boolean(message.starred) !== filters.isFlagged) return false;
    if (filters.hasAttachment !== null) {
      const attached = (message.realAttachments?.length ?? 0) > 0;
      if (attached !== filters.hasAttachment) return false;
    }
    return true;
  });
}

export function sortMessages<T extends SampleMessage>(messages: T[], sortKey: SortKey): T[] {
  const sorted = [...messages];
  if (sortKey === "oldest") {
    sorted.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  } else if (sortKey === "unread") {
    // Unread above read, newest first inside each group.
    sorted.sort((a, b) => {
      if (Boolean(a.unread) !== Boolean(b.unread)) return a.unread ? -1 : 1;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  } else {
    sorted.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }
  return sorted;
}
