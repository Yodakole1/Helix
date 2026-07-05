// Single source of truth for keyboard shortcuts: the list shown in
// Settings > Shortcuts, the default key bindings, and the parsing/matching
// helpers useKeyboardShortcuts.ts uses to compare a live KeyboardEvent
// against a (possibly user-rebound) combo string.
//
// A combo is a lowercase, "+"-joined string: modifiers first in a fixed
// order ("mod" for Ctrl/Cmd, then "shift", then "alt"), then the key itself
// (e.g. "c", "shift+u", "mod+,"). "mod" abstracts over Ctrl (Windows/Linux)
// vs Cmd (Mac) the same way most editors' keybinding systems do.

export type ShortcutId =
  | "compose"
  | "reply"
  | "replyAll"
  | "forward"
  | "archive"
  | "trash"
  | "focusSearch"
  | "openSettings"
  | "star"
  | "markUnread"
  | "markAllRead"
  | "refresh"
  | "nextMessage"
  | "prevMessage";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  defaultCombo: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "compose", label: "Compose a new message", defaultCombo: "c" },
  { id: "reply", label: "Reply to the open message", defaultCombo: "r" },
  { id: "replyAll", label: "Reply all", defaultCombo: "a" },
  { id: "forward", label: "Forward", defaultCombo: "f" },
  { id: "archive", label: "Archive the open message", defaultCombo: "e" },
  { id: "trash", label: "Trash the open message", defaultCombo: "backspace" },
  { id: "star", label: "Star / unstar the open message", defaultCombo: "s" },
  { id: "markUnread", label: "Mark the open message unread", defaultCombo: "shift+u" },
  { id: "markAllRead", label: "Mark all as read", defaultCombo: "shift+i" },
  { id: "nextMessage", label: "Select the next message", defaultCombo: "j" },
  { id: "prevMessage", label: "Select the previous message", defaultCombo: "k" },
  { id: "refresh", label: "Refresh the message list", defaultCombo: "shift+r" },
  { id: "focusSearch", label: "Focus the search box", defaultCombo: "/" },
  { id: "openSettings", label: "Open Settings", defaultCombo: "mod+," },
];

export const DEFAULT_SHORTCUT_BINDINGS: Record<ShortcutId, string> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s.defaultCombo]),
) as Record<ShortcutId, string>;

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

const NAMED_KEYS: Record<string, string> = {
  backspace: "Backspace",
  delete: "Delete",
  enter: "Enter",
  escape: "Esc",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

// Renders a stored combo for display, e.g. "mod+," -> "Ctrl+," (or "⌘,"
// on Mac), "shift+u" -> "Shift+U".
export function formatKeyCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac() ? "⌘" : "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return isMac() ? "⌥" : "Alt";
      if (NAMED_KEYS[part]) return NAMED_KEYS[part];
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}

// Builds the normalized combo string for a live KeyboardEvent, in the same
// format as defaultCombo/persisted bindings above.
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

// A combo consisting of just a modifier key on its own (e.g. pressing Shift
// with nothing else) isn't a usable binding.
export function isCompleteCombo(event: KeyboardEvent): boolean {
  return !["Shift", "Control", "Meta", "Alt"].includes(event.key);
}
