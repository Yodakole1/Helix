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
  "cyan:inbox": [
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
    },
  ],
  "purple:inbox": [
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

const ATTACHMENT_BY_ID: Record<number, SampleAttachment> = {
  5: { name: "helix-public-key.asc", size: "4 KB" },
};

export function getBody(id: number): string | undefined {
  return BODY_BY_ID[id];
}

export function getAttachment(id: number): SampleAttachment | undefined {
  return ATTACHMENT_BY_ID[id];
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
