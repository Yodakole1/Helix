# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Helix is a privacy-focused, cross-platform email client (desktop now, mobile
planned) built on a single codebase: direct IMAP/POP3/SMTP connections to
mail providers (no middleman sync servers), local encryption, and a
dark-mode-first, customizable UI. It is intended to be published as an
open-source project.

The project is in early development. The Rust backend has working IMAP
connection, folder listing, message fetching, and credential storage; the
frontend UI is a layout/visual preview wired to sample data, not yet
connected to the real backend commands. `docs/technical/backend-backlog.md`
tracks what's implemented vs. still planned in detail.

## Commands

```
npm install              # install JS deps
npm run dev               # Vite dev server only, browser, no native shell
npm run tauri dev         # full app: compiles Rust shell, opens native window, hot reload
npm run build              # production web build
npm run tauri build        # production desktop build/installer
npx tsc --noEmit            # typecheck the frontend (no script defined for this yet)
```

Rust backend (`src-tauri/`):

```
cd src-tauri
cargo test                          # unit tests only; network/Docker-dependent tests are #[ignore]d
cargo test <test_name>              # run a single test by (partial) name match
cargo test -- --ignored             # run the ignored tests (needs either network access to a real
                                     # IMAP server, or a local GreenMail container -- see
                                     # docs/technical/imap-core.md for the exact docker invocation)
```

Linux dev machines need a running Secret Service provider (gnome-keyring or
KWallet) for credential storage to work at all -- see
`docs/technical/credential-storage.md`. Native build prerequisites for Linux
are listed in `docs/technical/setup.md`.

There is no linter/formatter config committed yet (no ESLint/Prettier/
rustfmt config) and no frontend test runner is set up.

## Architecture

### Frontend: React Native Web, not plain React

Components under `src/` are written against the React Native API (`View`,
`Text`, `StyleSheet`, `Pressable`, ...) rather than raw DOM elements, even
though today they only render to the web via `react-native-web`. This is
deliberate: the same component tree is meant to run on real React Native
(iOS/Android) later without a rewrite. Vite aliases `react-native` to
`react-native-web` in `vite.config.ts` -- there is no actual `react-native`
runtime involved in the desktop build, only its types and `StyleSheet` API
surface as implemented by `react-native-web`.

Two thin shims in `src/lib/` exist purely to bridge gaps between RN's types
and what `react-native-web` actually does on web:
- `webStyle.ts` -- widens `ViewStyle` with `backdropFilter`/`filter`, which
  `react-native-web` passes straight through to CSS but RN's own types don't
  know about. `glassPanel()` is the shared helper for the translucent panel
  look used throughout the UI.
- `pressable.ts` -- widens the `Pressable` style-callback argument with
  `hovered`, which `react-native-web` provides for desktop pointer support
  but RN's own types only define `pressed` for.

Avoid sprinkling `as any` at call sites for either of these -- extend the
shared shim types instead if a new web-only capability is needed.

### Theme system (`src/theme/`)

`colors.ts`, `typography.ts`, `spacing.ts`, re-exported together via
`index.ts`. The visual style is dark, glassmorphism-based (translucent
panels via `glassPanel`, ambient background glows in `App.tsx`), with a
rotating accent-color system: `colorForIndex()` / `accentCycle` in
`colors.ts` assigns distinct colors to senders/folders/avatars instead of
reusing one accent everywhere, while the *active account's* accent
(`Accent` type in `Sidebar.tsx`) drives the highlight color used across all
three panels (`App.tsx` threads `accent` state down to `Sidebar`,
`MessageList`, and `ReaderPane`).

### Frontend layout

Three-pane shell in `App.tsx`: `Sidebar` (accounts + folders) |
`MessageList` (message rows for the active folder) | `ReaderPane` (selected
message body). `MessageList` currently owns `SAMPLE_MESSAGES`, illustrative
data only -- there is no account sync wired into the UI yet. `ReaderPane`
imports that same sample data by id rather than owning its own copy.

### Backend: Tauri 2 (Rust), one module per concern

`src-tauri/src/lib.rs` is the single place Tauri commands get registered
(`invoke_handler!`); each module owns its own commands:

- `credentials.rs` -- wraps the `keyring` crate behind
  `store_credential`/`get_credential`/`delete_credential`. Backend is chosen
  per-OS at compile time in `Cargo.toml` (`sync-secret-service` on Linux,
  `apple-native` on macOS, `windows-native` on Windows) since `keyring` ships
  with none enabled by default. Secrets are namespaced under service name
  `dev.helix.app`, keyed by `account_id`.
- `imap.rs` -- `connect_and_login` (TCP via `tokio::net`, TLS via
  `tokio-native-tls` wrapping the OS's native TLS lib, protocol via
  `async-imap` sharing Tauri's Tokio runtime) is wrapped by
  `login_with_stored_credential`, which resolves the password from the
  keychain and `.zeroize()`s it immediately after the login attempt,
  success or failure. Exposes `list_folders` and `fetch_messages`.
  `fetch_messages` opens the mailbox with `EXAMINE` (not `SELECT`) since
  it's preview-only and must not mark messages as seen, fetches by sequence
  number range (newest = highest sequence number, not by date), and decodes
  headers with `decode_header_text` (RFC 2047-aware, via `rfc2047-decoder`,
  falling back to lossy UTF-8 on malformed input).
- `account.rs` -- `add_account` composes the two modules above: store the
  credential, verify it by calling `imap::list_folders`, roll the credential
  back via `delete_credential` if verification fails. This is the pattern to
  follow for any future command that needs to coordinate credentials + a
  protocol call: never leave an unverified credential sitting in the
  keychain.

No connection pooling or persistent IMAP session exists yet -- every command
call opens and closes its own connection. That's intentional until there's
a real need for a long-lived session (e.g. IDLE-based push updates); don't
add pooling speculatively.

### Frontend <-> backend boundary

The frontend never handles raw passwords for stored accounts. `src/lib/
credentials.ts` is a thin `invoke()` wrapper around the Rust commands;
secrets go straight to the OS keychain via Rust and are never read back into
JS except as part of the one-time `store_credential` call during onboarding.
Any new Tauri command should preserve this: business logic and anything
secret-handling belongs in `src-tauri/src/`, not in the frontend.

### Testing conventions on the Rust side

Tests that need an external resource are marked `#[ignore]` and excluded
from the default `cargo test` run:
- Tests against a real IMAP server (`imap.gmail.com`) only exercise the
  login-failure path (no real credentials are committed), which is enough
  to prove the TCP/TLS/protocol-framing/keychain-lookup stack works end to
  end.
- One test exercises the actual EXAMINE/FETCH/envelope-decoding logic
  against a local GreenMail Docker container (command in
  `docs/technical/imap-core.md`), since that's the only path that actually
  reaches real message data.
- There is also a real (non-mock) hosting-provider test mailbox available
  for manual, throwaway verification when GreenMail isn't sufficient --
  credentials live in a gitignored `.env` at the project root and must never
  be duplicated into committed code, tests, or docs. Any such check should
  read the env vars at runtime, run a scratch test, then remove it again.

Header-decoding logic (`decode_header_text`, `format_address` in `imap.rs`)
has plain unit tests with no external dependency and runs in the default
`cargo test` pass.

## Conventions specific to this project

- This is meant to be a polished open-source codebase. Comments should read
  like a human engineer explaining a non-obvious decision, not boilerplate
  restating what the code does. No emojis anywhere -- code, comments,
  commit messages, or docs.
- `docs/user/` (end-user facing: what Helix is, current status, how to run
  it) and `docs/technical/` (architecture, stack-choice rationale, setup,
  per-feature implementation notes) are living documentation, not a one-time
  setup artifact. When a feature, architecture decision, or setup step
  lands, update or add the relevant doc in the same change rather than
  leaving it to drift -- `docs/technical/backend-backlog.md` is the running
  checklist of backend work, and each backlog item gets its own doc once
  implemented, following the pattern of `credential-storage.md` /
  `imap-core.md` / `account-onboarding.md`.
