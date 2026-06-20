# Architecture

## Stack

- **UI**: React + React Native Web (`react-native-web`). Components are
  written against the React Native API (`View`, `Text`, `StyleSheet`, etc.)
  rather than raw DOM elements, so the same code can later run on actual
  React Native for iOS/Android without a rewrite.
- **Bundler**: Vite, with `react-native` aliased to `react-native-web`.
- **Desktop shell**: Tauri 2 (Rust). Wraps the web UI in a native window
  using the OS's existing webview.
- **Languages**: TypeScript for the app code, Rust for the native shell.

## Why React Native Web instead of plain React?

Helix's goal is one codebase across desktop and mobile. Writing components
against the React Native API means the same component tree can run on web
today (via `react-native-web`) and on iOS/Android later (via real React
Native), instead of maintaining separate UIs per platform.

## Why Tauri instead of Electron?

Both were under consideration. We went with Tauri:

- **Bundle size and resource use.** Tauri uses the OS's existing webview
  (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) instead of
  bundling a full Chromium and Node runtime. Resulting binaries are
  typically tens of MB rather than 100+ MB, with lower idle memory and CPU
  use.
- **Security surface.** The native shell is Rust rather than Node.js with
  broad filesystem and process access by default. That fits Helix's
  security-first positioning — less native-privileged code, memory-safe
  by construction.

The trade-off: because Tauri renders through each OS's native webview
rather than one bundled Chromium, there's some risk of small rendering
differences between Windows, macOS, and Linux — particularly for newer CSS
features used in the glassmorphism / neon-accent visual style (e.g.
`backdrop-filter`). Electron avoids that by always shipping the same
Chromium build everywhere, at the cost of a much heavier app. Given
Helix's performance and security goals, Tauri is the better fit; if
cross-platform visual consistency turns into a real problem later, this is
the decision to revisit.

## Project layout

```
Helix/
  src/
    App.tsx             top-level layout: shell, ambient glow, modals
    main.tsx             entry point; imports self-hosted fonts
    theme/               design tokens (colors, typography, spacing)
    components/          Sidebar, MessageList, ReaderPane, modals, etc.
    data/                 shared sample/static data (e.g. accounts.ts)
    lib/                  small framework-agnostic helpers (credentials
                           bridge, hover-state typing, web-only style
                           escape hatch)
  index.html            Vite entry point
  vite.config.ts
  tsconfig.json
  src-tauri/            Rust desktop shell
    src/
      lib.rs             Tauri builder, command registration
      credentials.rs      OS-keychain credential storage (via `keyring`)
    Cargo.toml
    tauri.conf.json
  docs/
    user/               end-user facing documentation
    technical/          architecture and contributor documentation
```

## Design system

Helix's visual identity ("Cyber-Minimalism": OLED-black backgrounds, neon
accents, glass panels) lives in `src/theme/`:

- `colors.ts` -- background/border/text scales, the two account accents
  (`cyan`, `purple`), and a five-color `accentCycle` used to give senders,
  folders, and avatars distinct colors without repeating a single accent
  everywhere. Also exports `withAlpha()` (hex -> rgba string) and
  `colorForIndex()`.
- `typography.ts` -- three font roles: `display` (Space Grotesk, headers/
  brand), `ui` (Inter, body/controls), `mono` (JetBrains Mono, technical
  data -- ports, hosts, security copy).
- `spacing.ts` -- spacing scale and corner-radius scale.

Fonts are self-hosted via `@fontsource/*` packages, imported as a side
effect in `main.tsx`. This is a deliberate privacy/offline choice: the app
never makes a network request (e.g. to Google Fonts) just to render text.

### Glassmorphism and glow

Panels (`Sidebar`, `MessageList`, `ReaderPane`, modal cards) are
semi-transparent with a `backdrop-filter: blur(...)`, and `App.tsx` renders
a handful of large, heavily blurred, accent-colored circles behind
everything (`filter: blur(...)`) so the glass panels have actual color to
show through instead of just tinting flat black.

`backdropFilter` and `filter` aren't part of React Native's `ViewStyle`
type (they're web-only), so `src/lib/webStyle.ts` defines a `WebViewStyle`
interface that extends `ViewStyle` with those two properties, plus a
`glassPanel(hex, alpha, blurPx)` helper that returns a ready-made
background+blur style fragment. react-native-web passes both properties
straight through to CSS with vendor prefixing already handled.

### Hover states

`react-native-web`'s `Pressable` passes a web-only `hovered` flag to its
style callback (`style={(state) => ...}`), which React Native's own types
don't know about (`PressableStateCallbackType` only has `pressed`).
`src/lib/pressable.ts` exports a small `HoverState` type that widens this
locally rather than casting to `any` at every call site.

## Credential storage

Account passwords never touch app storage or JavaScript memory longer than
necessary -- `src-tauri/src/credentials.rs` exposes three Tauri commands
(`store_credential`, `get_credential`, `delete_credential`) backed by the
`keyring` crate, which talks to the OS's real credential store (Secret
Service on Linux, Keychain on macOS, Credential Manager on Windows).
Entries are namespaced under the service name `dev.helix.app`.

`src/lib/credentials.ts` is the JS-side wrapper around `@tauri-apps/api`'s
`invoke()`, used today by the Add Account modal. These calls only work
inside the actual Tauri webview -- in a plain browser (e.g. `npm run dev`
viewed directly in Chrome) `invoke()` has nothing to talk to and rejects,
which the UI surfaces as an inline error rather than crashing.

There is no account list, IMAP/SMTP sync, or persistence layer yet --
connecting an account today stores a credential and nothing else.

## A note on react-native-svg

The logo (`src/components/Logo.tsx`) renders raw DOM `<svg>`/`<path>`
elements instead of using `react-native-svg`. We tried `react-native-svg`
first, since it's the standard cross-platform way to draw vector graphics
in a React Native codebase, but its web build pulls in Fabric/TurboModule
files (`*NativeComponent.js`, `Native*Module.js`) that only exist for
React Native's New Architecture and have no react-native-web equivalent --
Vite's dev-server dependency scan (esbuild) crashes trying to resolve
them, even after preferring `.web.js` files via `resolve.extensions`.

Plain DOM SVG works fine today because the app only targets web/Tauri. It
will need to be swapped for `react-native-svg` (or revisited under a
Metro-based setup) when Helix actually ports to native iOS/Android, since
raw `<svg>` tags don't exist outside a DOM.

## Build / dev workflow

- `npm run dev` — Vite dev server only (browser, no native shell). Useful
  for fast UI iteration.
- `npm run tauri dev` — compiles the Rust shell and opens it pointed at
  the Vite dev server, with hot reload.
- `npm run build` — production web build.
- `npm run tauri build` — production desktop build/installer.
