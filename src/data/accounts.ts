import { colorForIndex, type AccountId } from "../theme";

export interface MailAccount {
  // The email address, used as-is -- it's already the natural unique key
  // for a mail account, no need for a separate generated id.
  id: AccountId;
  label: string;
  email: string;
}

// User overrides from the sidebar's right-click menu (rename / recolor an
// account) -- a flair on top of the defaults below, not a replacement for
// them. Partial since either field can be customized without the other.
export interface AccountOverride {
  label?: string;
  color?: string;
}

export type AccountOverrides = Record<AccountId, AccountOverride>;

// Resolves the color every part of the UI should use for this account --
// the override if the user set one via the sidebar's right-click menu,
// otherwise colorForIndex(its position in ACCOUNTS). Centralized here so
// Sidebar/SettingsModal/MessageList/App.tsx can't drift out of sync on
// what "this account's color" means.
export function resolveAccountColor(overrides: AccountOverrides, accountId: AccountId, index: number): string {
  return overrides[accountId]?.color ?? colorForIndex(index);
}

export function resolveAccountLabel(overrides: AccountOverrides, account: MailAccount): string {
  return overrides[account.id]?.label ?? account.label;
}

// Sample accounts used only when the app is running in browser dev mode
// without Tauri (npm run dev), so the UI has something to render. In the
// real app (npm run tauri dev) useAccounts() loads the actual persisted
// accounts from the backend and these are never shown.
export const SAMPLE_ACCOUNTS: MailAccount[] = [
  { id: "alex@helixmail.dev", label: "Work", email: "alex@helixmail.dev" },
  { id: "alex@protonmail.com", label: "Personal", email: "alex@protonmail.com" },
  { id: "alex.r@outlook.com", label: "Freelance", email: "alex.r@outlook.com" },
  { id: "alex@fastmail.com", label: "Newsletter", email: "alex@fastmail.com" },
  { id: "a.rivera@icloud.com", label: "Family", email: "a.rivera@icloud.com" },
];
