export interface FolderItem {
  id: string;
  label: string;
  glyph: string;
}

// Well-known folder name lookup -- used by the sidebar and message-list
// header to map raw IMAP names to friendly labels and icons. The id is the
// canonical lowercase key; aliases lets normalizeFolderId() match the many
// server-specific variants (Gmail's "[Gmail]/Sent Mail", Exchange's "Sent
// Items", etc.) to the same canonical id.
export const FOLDERS: FolderItem[] = [
  { id: "inbox", label: "Inbox", glyph: "IN" },
  { id: "drafts", label: "Drafts", glyph: "DR" },
  { id: "sent", label: "Sent", glyph: "SE" },
  { id: "spam", label: "Spam", glyph: "SP" },
  { id: "archive", label: "Archive", glyph: "AR" },
  { id: "trash", label: "Trash", glyph: "TR" },
];

// Maps from common server-side alias patterns to canonical FOLDERS ids.
const FOLDER_ALIASES: Record<string, string> = {
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  "[gmail]/sent mail": "sent",
  drafts: "drafts",
  "[gmail]/drafts": "drafts",
  junk: "spam",
  "junk email": "spam",
  "junk e-mail": "spam",
  "[gmail]/spam": "spam",
  trash: "trash",
  "deleted items": "trash",
  "[gmail]/trash": "trash",
  "[gmail]/bin": "trash",
  archive: "archive",
  "[gmail]/all mail": "archive",
  "all mail": "archive",
  inbox: "inbox",
};

// Returns the canonical FOLDERS id for a raw IMAP folder name, or the
// lowercased last path segment if no known alias matches.
export function normalizeFolderId(raw: string): string {
  const lower = raw.toLowerCase();
  if (FOLDER_ALIASES[lower]) return FOLDER_ALIASES[lower];
  // Strip namespace prefix: "INBOX.Sent" → "sent", "[Gmail]/Drafts" → "drafts"
  const last = lower.split(/[/.]/).pop() ?? lower;
  return FOLDER_ALIASES[last] ?? last;
}

// Human-readable label for a raw IMAP folder name. Uses FOLDERS' labels for
// well-known names; for unknowns, capitalises the last path segment.
export function folderLabel(raw: string): string {
  const canonical = normalizeFolderId(raw);
  const known = FOLDERS.find((f) => f.id === canonical);
  if (known) return known.label;
  const last = raw.split(/[/.]/).pop() ?? raw;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
