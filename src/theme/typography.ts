// Self-hosted via @fontsource (imported in main.tsx) rather than a Google
// Fonts link, so the app never makes a network request just to render text.
export const fontFamily = {
  display: '"Space Grotesk", sans-serif',
  ui: '"Inter", sans-serif',
  mono: '"JetBrains Mono", monospace',
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  base: 14,
  md: 16,
  lg: 20,
  xl: 28,
  display: 40,
} as const;
