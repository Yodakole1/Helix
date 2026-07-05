// A connected account's identity -- its email address today (see
// data/accounts.ts). Not a color: an account's color comes from
// colorForIndex(its position in ACCOUNTS), the same rotating-palette
// mechanism already used for folders/senders/avatars, so the UI isn't
// hard-capped at however many literal color names exist.
export type AccountId = string;

export const colors = {
  background: {
    base: "#000000",
    surface: "#09090B",
    panel: "#0D0D11",
  },
  border: {
    subtle: "rgba(255, 255, 255, 0.14)",
    strong: "rgba(255, 255, 255, 0.32)",
  },
  text: {
    primary: "#FFFFFF",
    secondary: "#D6D6DE",
    muted: "#9C9CA8",
  },
  accent: {
    cyan: "#22D3EE",
    purple: "#A855F7",
    green: "#9FFF3D",
    pink: "#F472B6",
    amber: "#FBBF24",
  },
} as const;

// Rotation used to give senders, folders, and avatars distinct colors
// instead of repeating a single accent everywhere.
export const accentCycle = [
  colors.accent.cyan,
  colors.accent.purple,
  colors.accent.green,
  colors.accent.pink,
  colors.accent.amber,
] as const;

export function colorForIndex(index: number): string {
  return accentCycle[((index % accentCycle.length) + accentCycle.length) % accentCycle.length];
}

// Stable color for a string key (a sender's email, a folder name). Unlike
// colorForIndex fed a row position, the same key always lands on the same
// cycle color -- so a sender's avatar doesn't change color when the list
// re-sorts, a search reorders rows, or new mail shifts everything down.
export function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return colorForIndex(Math.abs(hash));
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.substring(0, 2), 16);
  const g = parseInt(value.substring(2, 4), 16);
  const b = parseInt(value.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
