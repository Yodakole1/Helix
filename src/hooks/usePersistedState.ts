import { useCallback, useState } from "react";

// Scoped to numeric values (pane widths, the original consumer) -- kept
// separate from the generic JSON version below rather than folding into
// it, since its NaN-checked parsing is simpler than round-tripping
// `Number` through `JSON.parse`.
export function usePersistedState(key: string, initial: number): [number, (value: number) => void] {
  const [value, setValue] = useState<number>(() => {
    const stored = localStorage.getItem(key);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? parsed : initial;
  });

  const setAndPersist = useCallback(
    (next: number) => {
      setValue(next);
      localStorage.setItem(key, String(next));
    },
    [key],
  );

  return [value, setAndPersist];
}

// The generalized JSON version anticipated above -- account label/color
// overrides (Sidebar's right-click menu) are the first consumer that
// isn't a plain number. Falls back to `initial` on missing or corrupted
// (e.g. pre-existing key holding an incompatible shape) stored JSON,
// rather than throwing.
export function usePersistedJSON<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (stored === null) return initial;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return initial;
    }
  });

  const setAndPersist = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
    [key],
  );

  return [value, setAndPersist];
}
