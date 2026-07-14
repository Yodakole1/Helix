import { formatClockTime } from "../lib/timeFormat";

export interface RealAttachment {
  index: number;
  name: string;
  contentType: string | null;
  size: number;
}

export interface SampleMessage {
  id: number;
  sender: string;
  senderEmail: string;
  to: string;
  subject: string;
  preview: string;
  // ISO timestamp. Display strings are derived at render time via
  // formatMessageTime so they stay correct as "now" moves forward.
  date: string;
  unread: boolean;
  starred: boolean;
  // True when the message HTML contains remote images -- used by the
  // "Block remote images" setting to decide whether to strip/offer them.
  hasRemoteImage?: boolean;
  // Cc recipients from the envelope (summary) or body parse.
  cc?: string;
  // PGP metadata -- populated by fetch_message_body when the body was
  // signed or encrypted inline.
  encrypted?: boolean;
  pgpSignedBy?: string;
  pgpSignatureValid?: boolean;
  // S/MIME metadata -- populated by fetch_message_body when the message
  // carried an S/MIME signature or was S/MIME encrypted.
  smimeSigned?: boolean;
  smimeVerified?: boolean | null;
  smimeEncrypted?: boolean;
  smimeSignerEmail?: string;

  // --- Fields populated after fetch_message_body is called ---

  textBody?: string;
  htmlBody?: string;
  // Attachment metadata returned by fetch_message_body.
  realAttachments?: RealAttachment[];
  // RFC 5322 threading headers for Reply/Reply-All/Forward.
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
  // Non-null when the sender requested a read receipt (Disposition-Notification-To).
  dispositionNotificationTo?: string;
  // Set once fetch_message_body has been called, so the reader pane
  // doesn't trigger redundant fetches on every re-render.
  bodyLoaded?: boolean;
  // IMAP UID. For real messages id === uid.
  uid?: number;
  // POP3 message number (this session). POP3 has no stable UID, so body
  // fetch and attachment download address messages by this number instead
  // of a uid. Set only for messages from a POP3 account.
  pop3Number?: number;
  // POP3 UIDL -- the stable per-message identifier from the RFC 1939 UIDL
  // command. Survives across sessions (unlike `pop3Number`), so it is used
  // as the cache key for offline body/attachment lookups. null for servers
  // that don't implement UIDL (rare) -- those messages aren't cached.
  pop3Uidl?: string;
}

// Whole-calendar-day difference between "now" and the given date.
// 0 = today, 1 = yesterday. Shared by the time label and date-range
// filter so "today"/"yesterday" mean the same thing in both places.
export function calendarDayDiff(iso: string): number {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000);
}

export function formatMessageTime(iso: string): string {
  const dayDiff = calendarDayDiff(iso);
  const date = new Date(iso);
  if (dayDiff === 0) return formatClockTime(date);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Parses "Name <email>" or bare "email" into { name, email }.
// The Rust side formats addresses as "Name <email>" via format_address;
// we split them back out here for display.
export function parseFromField(raw: string | null): { name: string; email: string } {
  if (!raw) return { name: "(unknown)", email: "" };
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: raw, email: raw };
}

// Maps one MessageSummary (from fetch_messages) to a SampleMessage.
// Only list-view fields are available here; body fields are populated
// later by updateMessageBody() when the user opens the message.
export function summaryToMessage(
  summary: { uid: number | null; subject: string | null; from: string | null; date: string | null; seen: boolean; flagged: boolean },
  fallbackIndex: number,
): SampleMessage {
  const { name: sender, email: senderEmail } = parseFromField(summary.from);
  const id = summary.uid ?? fallbackIndex;
  return {
    id,
    // Only a real IMAP UID may be used for server mutations -- when the
    // summary has none, uid stays undefined (id falls back to the list
    // index purely for React keys/selection) so seen/flag/move calls are
    // skipped instead of targeting whatever message happens to own the
    // fabricated UID on the server.
    uid: summary.uid ?? undefined,
    sender,
    senderEmail,
    to: "",
    subject: summary.subject ?? "(no subject)",
    preview: "",
    date: summary.date ?? new Date().toISOString(),
    unread: !summary.seen,
    starred: summary.flagged,
  };
}
