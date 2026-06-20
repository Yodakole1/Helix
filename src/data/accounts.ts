import type { Accent } from "../theme";

export interface MailAccount {
  id: Accent;
  label: string;
  email: string;
}

// Each connected account gets its own accent and its own folder tree, the
// same way Thunderbird lists every account separately in the folder pane.
// Shared between Sidebar (folder tree) and SettingsModal (account list) so
// there's one source of truth instead of two copies drifting apart.
export const ACCOUNTS: MailAccount[] = [
  { id: "cyan", label: "Work", email: "alex@helixmail.dev" },
  { id: "purple", label: "Personal", email: "alex@protonmail.com" },
];
