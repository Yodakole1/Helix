// A connected account's identity -- its email address today (see
// data/accounts.ts). Not a color: an account's color comes from
// colorForIndex(its position in ACCOUNTS), the same rotating-palette
// mechanism already used for folders/senders/avatars, so the UI isn't
// hard-capped at however many literal color names exist.
export type AccountId = string;

// ── Theme selection ──────────────────────────────────────────────────────────
// The palette below is baked into StyleSheet.create() calls at module load,
// so the theme is read once here and a switch applies via a reload (Settings
// does that automatically on Save). "light" is deliberately not pure white --
// soft gray-whites, so it doesn't glare next to the dark-first design.

export type ThemeName = "dark" | "light";
export const THEME_STORAGE_KEY = "helix:theme";

function readTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export const themeName: ThemeName = readTheme();
export const isLightTheme = themeName === "light";

interface Palette {
  background: { base: string; surface: string; panel: string };
  border: { subtle: string; strong: string };
  text: { primary: string; secondary: string; muted: string };
  accent: { cyan: string; purple: string; green: string; pink: string; amber: string };
}

const darkColors: Palette = {
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
    // Was #9FFF3D -- a neon/lime green that read as glaring wherever an
    // account or calendar happened to land on it (accentCycle drives
    // buttons, highlights, and the calendar's "today"/add-task accent, not
    // just avatar dots), unlike the other four accents in this cycle which
    // all sit at a comparable, comfortable saturation.
    green: "#4DCB62",
    pink: "#F472B6",
    amber: "#FBBF24",
  },
};

// Deliberately dimmer than a typical light theme -- muted warm grays rather
// than bright white, so it doesn't glare ("light", not "white").
const lightColors: Palette = {
  background: {
    base: "#D6D9DE",
    surface: "#E2E4E8",
    panel: "#ECEDF0",
  },
  border: {
    subtle: "rgba(20, 24, 34, 0.16)",
    strong: "rgba(20, 24, 34, 0.32)",
  },
  text: {
    primary: "#1A1C21",
    secondary: "#3A3D46",
    muted: "#5F636C",
  },
  // Deeper accent versions so they hold contrast against light surfaces.
  accent: {
    // Was #0891B2 -- cyan is accentCycle's first entry, so it's the
    // default color for the first (often only) account, meaning it's the
    // color a light-theme user sees the most: compose button, active
    // highlights, sidebar accents. #0891B2 read as too saturated/glary
    // for something that pervasive against a light background; this is
    // the same hue pulled back to a calmer, less blue-heavy teal.
    cyan: "#2C7F96",
    purple: "#7C3AED",
    green: "#4D7C0F",
    pink: "#BE185D",
    amber: "#B45309",
  },
};

export const colors: Palette = isLightTheme ? lightColors : darkColors;

// Rotation used to give senders, folders, and avatars distinct colors
// instead of repeating a single accent everywhere.
export const accentCycle = [
  colors.accent.cyan,
  colors.accent.purple,
  colors.accent.green,
  colors.accent.pink,
  colors.accent.amber,
] as const;

// The full pick-a-color palette offered in Appearance and the calendar's
// per-source color picker. Softer than the accent cycle on purpose -- these
// exist because the default rotation reads as too loud for some setups, so
// every column has a muted row.
export const EXTENDED_PALETTE: string[] = [
  // blues / teals
  "#22D3EE", "#38BDF8", "#60A5FA", "#3B82F6", "#2DD4BF", "#14B8A6",
  // purples / pinks
  "#A855F7", "#8B5CF6", "#C084FC", "#F472B6", "#E879A9", "#D0648F",
  // greens -- first entry was #9FFF3D, the same neon lime already toned
  // down in accentCycle above; softened the same way here since this row
  // is exactly what the calendar's per-source color picker offers.
  "#91D742", "#84CC16", "#4ADE80", "#22C55E", "#7CB86B", "#5F9E63",
  // warm
  "#FBBF24", "#F59E0B", "#FB923C", "#F87171", "#E0715F", "#D9A45B",
  // muted / neutral
  "#94A3B8", "#8B9DAF", "#A08FB0", "#B0A18F", "#7F8CAA", "#9AA88F",
];

// Default colors for calendars that haven't been explicitly recolored --
// the muted/neutral row above, reused rather than duplicated. Calendar
// event chips sit on screen far longer than a one-off accent highlight, so
// they get this row instead of accentCycle's full-saturation hues, which
// read as neon over a whole month grid in both themes.
export const CALENDAR_DEFAULT_COLORS: string[] = EXTENDED_PALETTE.slice(-6);

export function colorForIndex(index: number): string {
  return accentCycle[((index % accentCycle.length) + accentCycle.length) % accentCycle.length];
}

// Avatar letter-circle backgrounds (colorForLetter below) get one color per
// starting letter -- A through Z each land on their own distinct hue,
// evenly swept around the color wheel, rather than a handful of colors
// hash-repeating across an alphabet's worth of senders. accentCycle's
// full-saturation hues are meant to pop as one-off highlights (an account,
// a folder); a whole inbox of neighboring rows all that loud reads as
// glaring, so the saturation/lightness are tunable via AvatarColorStyle
// instead of fixed at accentCycle's level.
const AVATAR_LETTER_COUNT = 26;

export type AvatarColorStyle = "muted" | "balanced" | "vivid";

const AVATAR_STYLE_PARAMS: Record<AvatarColorStyle, { saturation: number; lightnessDark: number; lightnessLight: number }> = {
  muted: { saturation: 32, lightnessDark: 62, lightnessLight: 42 },
  balanced: { saturation: 55, lightnessDark: 66, lightnessLight: 38 },
  vivid: { saturation: 88, lightnessDark: 62, lightnessLight: 44 },
};

function hslToHex(h: number, s: number, l: number): string {
  const sFrac = s / 100;
  const lFrac = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sFrac * Math.min(lFrac, 1 - lFrac);
  const f = (n: number) => lFrac - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Exported so Settings can render a live preview of a style before it's
// applied (avatar colors are baked in at module load like theme, so
// actually switching styles takes a reload -- this lets the picker show
// what the reload will produce without waiting for it).
export function avatarPaletteForStyle(style: AvatarColorStyle): string[] {
  const { saturation, lightnessDark, lightnessLight } = AVATAR_STYLE_PARAMS[style];
  const lightness = isLightTheme ? lightnessLight : lightnessDark;
  return Array.from({ length: AVATAR_LETTER_COUNT }, (_, i) => hslToHex((360 / AVATAR_LETTER_COUNT) * i, saturation, lightness));
}

export const AVATAR_COLOR_STYLE_STORAGE_KEY = "helix:avatarColorStyle";
export const DEFAULT_AVATAR_COLOR_STYLE: AvatarColorStyle = "balanced";

function readAvatarColorStyle(): AvatarColorStyle {
  try {
    const stored = localStorage.getItem(AVATAR_COLOR_STYLE_STORAGE_KEY);
    if (stored === "muted" || stored === "balanced" || stored === "vivid") return stored;
  } catch {
    // Corrupt/missing localStorage value -- fall through to the default.
  }
  return DEFAULT_AVATAR_COLOR_STYLE;
}

const avatarLetterPalette = avatarPaletteForStyle(readAvatarColorStyle());

// Stable, distinct color per starting letter. Callers should pass the exact
// character they render as the avatar's initial (not some other identifier
// like a full email), so the circle's color and its visible letter can
// never disagree. Non-letter initials (digits, "?", emoji) fall back to a
// char-code modulo so they still land on some deterministic color.
export function colorForLetter(letter: string): string {
  const code = letter.toUpperCase().charCodeAt(0) - 65; // 'A' = 65
  const index = code >= 0 && code < AVATAR_LETTER_COUNT ? code : Math.abs(code) % AVATAR_LETTER_COUNT;
  return avatarLetterPalette[index];
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.substring(0, 2), 16);
  const g = parseInt(value.substring(2, 4), 16);
  const b = parseInt(value.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
