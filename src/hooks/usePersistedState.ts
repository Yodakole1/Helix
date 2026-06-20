import { useCallback, useState } from "react";

// Scoped to numeric values (pane widths, the only current consumer) rather
// than a generic JSON-serializing store -- generalize this if a second kind
// of value needs persisting.
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
