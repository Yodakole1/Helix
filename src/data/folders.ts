export interface FolderItem {
  id: string;
  label: string;
  glyph: string;
}

// Shared between Sidebar (folder tree) and MessageList (pane header label) --
// one source of truth instead of two copies drifting apart, the same reason
// ACCOUNTS lives in its own file.
export const FOLDERS: FolderItem[] = [
  { id: "inbox", label: "Inbox", glyph: "IN" },
  { id: "drafts", label: "Drafts", glyph: "DR" },
  { id: "sent", label: "Sent", glyph: "SE" },
  { id: "spam", label: "Spam", glyph: "SP" },
  { id: "archive", label: "Archive", glyph: "AR" },
  { id: "trash", label: "Trash", glyph: "TR" },
];
