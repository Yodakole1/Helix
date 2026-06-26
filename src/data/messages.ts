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
  // ISO timestamp -- real, so sorting/filtering by date is real too. Display
  // strings ("Yesterday", "Mon") are derived from this at render time via
  // formatMessageTime rather than stored, so they stay correct as "now"
  // moves forward.
  date: string;
  unread: boolean;
  starred: boolean;
  // Marketing/notification mail commonly embeds a remote banner image (and,
  // less innocently, a remote tracking pixel) -- this is the one sample
  // message that has one, so Settings' "Block remote images" toggle has
  // something real to demonstrate against. Optional rather than required on
  // every message since it's the rare case, not the common one.
  hasRemoteImage?: boolean;
  // A second participant beyond sender/to -- just enough to make Reply-All
  // visibly different from Reply on the one sample message that has it,
  // not a real Cc list (real mail can have several).
  cc?: string;
  // Set on sample data only; real messages get these from fetch_message_body.
  encrypted?: boolean;
  pgpSignedBy?: string;
  pgpSignatureValid?: boolean;

  // --- Real data fields, populated when fetch_message_body has been called ---

  // Plain-text body from the backend. Falls back to the static getBody()
  // lookup for sample messages that don't have a backend source.
  textBody?: string;
  // HTML body. Falls back to getHtmlBody() for sample messages.
  htmlBody?: string;
  // Attachments returned by fetch_message_body. Falls back to getAttachments().
  realAttachments?: RealAttachment[];
  // RFC 5322 threading headers -- needed for real Reply/Reply-All/Forward.
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
  // Set once fetch_message_body has been called for this message, so the
  // reader pane doesn't trigger redundant fetches on every re-render.
  bodyLoaded?: boolean;
  // The IMAP UID for this message. Undefined for sample messages (they have
  // no backend). For real messages id === uid -- the uid is a u32 on the
  // Rust side; we use it directly as the JS id so there's only one
  // identifier to track rather than two.
  uid?: number;
}

export interface SampleAttachment {
  name: string;
  size: string;
}

// Illustrative content for the layout preview only -- there's no account
// sync yet, so none of this is real mail. Keyed by "<account>:<folder>" so
// each folder/account pair gets its own dataset instead of one flat list
// reused everywhere regardless of what's selected in the sidebar. Folders
// with no entry here render empty rather than needing an explicit [] for
// every account/folder combination.
// Exported (not just module-private) so useMessageStore can seed its own
// mutable React state from this -- this object itself is never mutated.
export const SEED_MESSAGES_BY_KEY: Record<string, SampleMessage[]> = {
  "alex@helixmail.dev:inbox": [
    {
      id: 1,
      sender: "Helix Team",
      senderEmail: "team@helix.dev",
      to: "alex@helixmail.dev",
      subject: "Welcome to Helix",
      preview: "Thanks for trying the early build. Here's what's already working.",
      date: "2026-06-20T09:14:00",
      unread: true,
      starred: false,
    },
    {
      id: 2,
      sender: "Maya Chen",
      senderEmail: "maya.chen@helixmail.dev",
      to: "alex@helixmail.dev",
      subject: "Re: Q3 roadmap",
      preview: "Looks good, one comment on the timeline for the encryption work.",
      date: "2026-06-20T08:52:00",
      unread: true,
      starred: false,
      cc: "daniel.kim@helixmail.dev",
    },
    {
      id: 3,
      sender: "GitHub",
      senderEmail: "notifications@github.com",
      to: "alex@helixmail.dev",
      subject: "[helix] New issue opened",
      preview: "Issue #42: add OAuth support for Gmail and Outlook accounts.",
      date: "2026-06-19T16:30:00",
      unread: false,
      starred: false,
    },
    {
      id: 4,
      sender: "Daniel Kim",
      senderEmail: "daniel.kim@helixmail.dev",
      to: "alex@helixmail.dev",
      subject: "Server migration notes",
      preview: "Sending over the IMAP server config we discussed on the call.",
      date: "2026-06-19T10:05:00",
      unread: false,
      starred: false,
    },
    {
      id: 5,
      sender: "Helix Team",
      senderEmail: "team@helix.dev",
      to: "alex@helixmail.dev",
      subject: "Your security keys are ready",
      preview: "Your PGP keypair has been generated and stored in your keychain.",
      date: "2026-06-15T13:00:00",
      unread: false,
      starred: true,
      encrypted: true,
      pgpSignedBy: "team@helix.dev",
      pgpSignatureValid: true,
    },
  ],
  "alex@protonmail.com:inbox": [
    {
      id: 6,
      sender: "Priya Nair",
      senderEmail: "priya.nair@gmail.com",
      to: "alex@protonmail.com",
      subject: "Dinner Saturday?",
      preview: "A few of us are getting together around 7 -- you free?",
      date: "2026-06-20T11:20:00",
      unread: true,
      starred: false,
    },
    {
      id: 7,
      sender: "ProtonMail",
      senderEmail: "noreply@protonmail.com",
      to: "alex@protonmail.com",
      subject: "Your storage is almost full",
      preview: "You're using 4.8 GB of your 5 GB plan. Consider upgrading.",
      date: "2026-06-19T09:00:00",
      unread: false,
      starred: false,
      hasRemoteImage: true,
    },
    {
      id: 8,
      sender: "Tom Reyes",
      senderEmail: "tomreyes@gmail.com",
      to: "alex@protonmail.com",
      subject: "Photos from the trip",
      preview: "Finally got around to uploading these, sorry for the delay.",
      date: "2026-06-15T18:45:00",
      unread: false,
      starred: false,
    },
  ],
};

// Same keying as MESSAGES_BY_KEY, but by message id rather than account/folder
// since ids are unique within this sample set.
const BODY_BY_ID: Record<number, string> = {
  1: "Thanks for trying the early build. The desktop shell and account silos are wired up. Account setup and real IMAP sync are next.",
  2: "Looks good, one comment on the timeline for the encryption work -- can we slot key generation before the OAuth flow instead of after?",
  3: "Issue #42: add OAuth support for Gmail and Outlook accounts. Filed by a contributor, needs triage.",
  4: "Sending over the IMAP server config we discussed on the call. Let me know if port 993 with implicit TLS works on your end.",
  5: "Your PGP keypair has been generated and stored in your OS keychain. The attachment below holds the exported public key.",
  6: "A few of us are getting together around 7 at the usual place -- let me know if you're free, would be good to catch up.",
  7: "You're using 4.8 GB of your 5 GB plan. Consider upgrading to keep receiving new mail without interruption.",
  8: "Finally got around to uploading these, sorry for the delay -- the one from the overlook is worth a scroll down for.",
};

const ATTACHMENT_BY_ID: Record<number, SampleAttachment[]> = {
  5: [{ name: "helix-public-key.asc", size: "4 KB" }],
  8: [
    { name: "overlook.jpg", size: "2.1 MB" },
    { name: "trailhead.jpg", size: "1.8 MB" },
  ],
};

// One sample message (the storage-warning mail, which already has
// hasRemoteImage: true) gets a real HTML body instead of plain text, so
// the sanitizer + remote-image-blocking path has an actual <img> tag to
// act on rather than a static placeholder card. example.com is the IANA
// documentation domain -- these URLs are illustrative, never a real
// outbound request target.
const HTML_BODY_BY_ID: Record<number, string> = {
  7: `<div>
    <img src="https://example.com/promo/storage-banner.png" alt="Storage almost full" width="480" height="120" />
    <p>You're using <b>4.8 GB</b> of your 5 GB plan.</p>
    <p>Consider <a href="https://example.com/upgrade">upgrading your plan</a> to keep receiving new mail without interruption.</p>
    <img src="https://example.com/track/open-pixel.gif" alt="" width="1" height="1" />
  </div>`,
};

export function getBody(id: number): string | undefined {
  return BODY_BY_ID[id];
}

export function getHtmlBody(id: number): string | undefined {
  return HTML_BODY_BY_ID[id];
}

export function getAttachments(id: number): SampleAttachment[] {
  return ATTACHMENT_BY_ID[id] ?? [];
}

export interface KnownAddress {
  name: string;
  email: string;
}

// Stand-in for a real contacts/address-book backend -- senders seen across
// the sample inbox, deduped by email. search_contacts already exists as a
// real Tauri command (see docs/technical/contacts.md) but nothing in the
// frontend calls it yet, same as the rest of this file's data.
const KNOWN_ADDRESSES: KnownAddress[] = Array.from(
  new Map(
    Object.values(SEED_MESSAGES_BY_KEY)
      .flat()
      .map((message) => [message.senderEmail, { name: message.sender, email: message.senderEmail }]),
  ).values(),
);

export function searchKnownAddresses(query: string, limit = 5): KnownAddress[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return [];
  return KNOWN_ADDRESSES.filter(
    (address) => address.email.toLowerCase().includes(trimmed) || address.name.toLowerCase().includes(trimmed),
  ).slice(0, limit);
}

// Whole-calendar-day difference between "now" and the given date -- 0 is
// today, 1 is yesterday, negative would be the future. Shared by the time
// label and the date-range filter so "today"/"yesterday" mean the same
// thing in both places.
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
  if (dayDiff === 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Parses "Name <email>" or bare "email" into { name, email }.
// The Rust side formats addresses as "Name <email>" (format_address /
// format_parsed_address); we split them back out here for display.
export function parseFromField(raw: string | null): { name: string; email: string } {
  if (!raw) return { name: "(unknown)", email: "" };
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: raw, email: raw };
}

// Maps one MessageSummary (from fetch_messages / imap.rs) to a SampleMessage
// that all existing UI components can render without change. Only the list-
// view fields (sender, subject, date, seen/flagged) are available at this
// stage; body fields are populated later by updateMessageBody() once the user
// opens the message (fetch_message_body).
export function summaryToMessage(
  summary: { uid: number | null; subject: string | null; from: string | null; date: string | null; seen: boolean; flagged: boolean },
  fallbackIndex: number,
): SampleMessage {
  const { name: sender, email: senderEmail } = parseFromField(summary.from);
  const id = summary.uid ?? fallbackIndex;
  return {
    id,
    uid: id,
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
