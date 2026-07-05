import { useEffect } from "react";
import { comboFromEvent, type ShortcutId } from "../lib/shortcuts";

export type ShortcutHandlers = Record<ShortcutId, () => void>;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

// Gmail-style shortcuts, global but inert while typing in a text field or
// while a modal is open (`enabled` -- App.tsx passes
// `!composeOpen && !settingsOpen && !addAccountOpen` so e.g. "r" while
// composing doesn't fire a second, unrelated reply). `bindings` is the
// (possibly user-rebound, see Settings > Shortcuts) combo string per
// shortcut id -- matching is exact string equality against the live
// event's normalized combo (see comboFromEvent), so a binding that
// requires a modifier only ever fires with that modifier held, and a bare
// letter binding never fires with an unrelated modifier held.
export function useKeyboardShortcuts(
  enabled: boolean,
  bindings: Record<ShortcutId, string>,
  handlers: ShortcutHandlers,
) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const combo = comboFromEvent(event);

      for (const id of Object.keys(bindings) as ShortcutId[]) {
        const bound = bindings[id];
        // Backspace and Delete are treated as interchangeable regardless
        // of which one is actually bound -- some keyboards/layouts only
        // have one of the two.
        const matches =
          combo === bound ||
          (bound === "backspace" && combo === "delete") ||
          (bound === "delete" && combo === "backspace");
        if (!matches) continue;
        event.preventDefault();
        handlers[id]();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, bindings, handlers]);
}
