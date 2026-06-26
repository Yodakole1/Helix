import { useEffect } from "react";

export interface ShortcutHandlers {
  onCompose: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onFocusSearch: () => void;
  onOpenSettings: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

// Gmail-style single-letter shortcuts, global but inert while typing in a
// text field or while a modal is open (`enabled` -- App.tsx passes
// `!composeOpen && !settingsOpen && !addAccountOpen` so e.g. "r" while
// composing doesn't fire a second, unrelated reply). Same
// window-level-listener shape as useEscapeKey.ts, just more keys.
export function useKeyboardShortcuts(enabled: boolean, handlers: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const openSettingsChord = (event.metaKey || event.ctrlKey) && event.key === ",";
      if (openSettingsChord) {
        event.preventDefault();
        handlers.onOpenSettings();
        return;
      }

      // Every other shortcut here is a bare, unmodified key -- a held
      // modifier means this is some other browser/OS shortcut passing
      // through, not one of ours.
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "c":
          handlers.onCompose();
          break;
        case "/":
          event.preventDefault();
          handlers.onFocusSearch();
          break;
        case "r":
          handlers.onReply();
          break;
        case "a":
          handlers.onReplyAll();
          break;
        case "f":
          handlers.onForward();
          break;
        case "e":
          handlers.onArchive();
          break;
        case "Backspace":
        case "Delete":
          handlers.onTrash();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handlers]);
}
