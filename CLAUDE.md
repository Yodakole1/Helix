# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Helix is a privacy-focused, cross-platform email client (desktop now, mobile
planned) built on a single codebase: direct IMAP/POP3/SMTP connections to
mail providers (no middleman sync servers), local encryption, and a
dark-mode-first, customizable UI. It is intended to be published as an
open-source project.

The project is in early development. The Rust backend is still ahead of the
frontend overall, but the gap is narrower than it used to be: account
onboarding (`add_account`/`list_accounts`/`remove_account`), PGP key
management, local-cache stats/clearing, and desktop notification permissions
are now real, frontend-wired features, not just backend commands sitting
unused. What's still sample-data-only is the core mailbox experience itself
-- there is no real `account_id` flowing through the sidebar/message list/
reader pane yet, so folder listing, message fetch, mailbox mutations
(read/flag/move), sending, and the unified inbox all still operate on
`src/data/`'s sample data rather than the real IMAP/SMTP/POP3 backend.
`docs/technical/backend-backlog.md` tracks backend work in detail;
`docs/technical/frontend-roadmap.md` is the frontend-side equivalent --
check both before assuming something is or isn't wired. Each backend module
has its own doc in `docs/technical/` once it lands.

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
message body). `App.tsx` owns the cross-pane state -- `accent`,
`selectedFolder` (per account), pane widths, and breakpoint/view-stack state
-- and threads it down, rather than panes tracking their own slice of it.

The shell is responsive via `useBreakpoint()` (`src/hooks/useBreakpoint.ts`,
wrapping `useWindowDimensions`): desktop (>=1080px) shows all three panes
with draggable `Splitter` components between them; tablet (720-1079px) drops
the sidebar to a dismissable overlay (toggled by a corner button) and keeps
list+reader side by side; mobile (<720px) shows one pane at a time with
list/reader view-stack navigation (`ReaderPane`'s `onBack`). Pane widths
persist across reloads via `usePersistedState` (`src/hooks/
usePersistedState.ts`, a thin localStorage-backed hook scoped to numeric
layout values). `MessageList` renders rows through `FlatList` rather than a
plain `.map()`, so only visible rows mount.

Sample message data lives in `src/data/messages.ts`, keyed by
`"<account>:<folder>"` (`getMessagesFor`/`findMessage`) -- illustrative only,
there is no account sync wired into the UI yet, but folder/account switching
in the sidebar now actually changes what the list and reader pane show
rather than always rendering the same fixed rows. Folder metadata
(id/label/glyph) lives in `src/data/folders.ts`, shared between `Sidebar`
and `MessageList`'s header label. Accounts are no longer pinned to a fixed
two-color enum -- `AccountId` (an alias for the account's email) is the
identity, and color comes from `colorForIndex()` keyed by position in
`ACCOUNTS` (`src/data/accounts.ts`), overridable per-account via the
sidebar's right-click context menu. Settings' "Unified inbox" toggle
switches `MessageList` from the active account/folder to
`useMessageStore.getUnifiedInbox()` (every account's INBOX merged). See
`docs/technical/frontend-layout.md` for the breakpoint/splitter/persistence
details and the rest of this layer's non-obvious decisions.

One cross-cutting gotcha worth knowing before touching any dropdown/menu/
suggestion-list component: every `react-native-web` `View` is an implicit
CSS stacking context (non-auto `zIndex` semantics apply even when nothing
sets one), so a high `zIndex` deep in the tree can never out-rank an
unrelated element higher up -- it only wins against its own siblings inside
its immediate parent. The fix used throughout this codebase is
`src/components/FloatingPortal.tsx` + `src/hooks/useAnchorRect.ts`: measure
the trigger's `getBoundingClientRect()` and render the floating content via
`react-dom`'s `createPortal` straight onto `document.body` at fixed
viewport coordinates, bypassing intermediate stacking contexts entirely
instead of trying to out-rank them. `Dropdown`, `MessageList`'s sort menu,
and `AddressField`'s autocomplete suggestions all use this pattern; a new
floating menu/popover should too rather than reaching for a bare `zIndex`.

### Backend: Tauri 2 (Rust), one module per concern

`src-tauri/src/lib.rs` is the single place Tauri commands get registered
(`invoke_handler!`); each module owns its own commands, and each has a
matching doc under `docs/technical/` with the full design and verification
story:

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
  success or failure. Exposes `list_folders`, `fetch_messages` (`EXAMINE`,
  not `SELECT` -- preview-only, must not mark messages seen, fetched by
  sequence-number range since that's positional not chronological, headers
  decoded via `decode_header_text` which is RFC 2047-aware with a lossy-UTF8
  fallback), `fetch_message_body` (`SELECT` + `UID FETCH BODY[]`, parsed by
  `mail_parser` -- this one *does* mark `\Seen`, since opening a message is
  real reading), and the mutation commands `set_message_seen`/
  `set_message_flagged`/`move_message_to_folder` (archive/trash are just the
  move command with the account's archive/trash folder name; moving tries
  `MOVE`, falls back to `UID COPY`+`UIDPLUS` `EXPUNGE`, then a SEARCH-based
  dance that avoids destroying other already-`\Deleted` messages, depending
  on what the server's `CAPABILITY` actually advertises). `parse_message_body`
  is `pub(crate)` specifically so `pop3.rs` can reuse the same raw-bytes-to-
  `MessageBody` logic. `MessageBody` also carries `from`/`to`/`cc`/`reply_to`
  and `message_id`/`in_reply_to`/`references` (angle brackets stripped) --
  the recipient-resolution and threading-header groundwork Reply/Reply-All/
  Forward (and later, message threading) build on top of; see
  `smtp.rs` below for the sending half.
- `smtp.rs` -- `send_message`, same account_id/keychain convention as IMAP.
  `use_starttls` is a caller-supplied flag (not inferred from port) that
  picks `lettre`'s `relay()` (implicit TLS) vs. `starttls_relay()`; either
  way the TLS step is mandatory, no downgradable path. Supports real
  multipart MIME now (`html`/`attachments` params, built via `lettre`'s
  `MultiPart`/`Attachment` in `build_multipart_body`) -- falls back to the
  original single-`TEXT_PLAIN`-body path when neither is supplied. Also
  takes `in_reply_to`/`references` params, set verbatim (re-wrapped in
  `<...>`) via `lettre`'s `InReplyTo`/`References` headers -- building the
  right values (the original message's `message_id`, and its `references`
  with that `message_id` appended) is the caller's job, not validated
  here. `encrypt: true` combined with `html`/`attachments` is a hard
  upfront error: PGP here stays inline-armored plain-text only (see
  `pgp.rs` below), so encrypting
  a multipart message would mean silently encrypting only part of it.
- `discovery.rs` -- `discover_server_config(email)` resolves IMAP/SMTP
  host+port from just an email address: a small hand-verified hardcoded
  table first (currently just Gmail), then DNS SRV per RFC 6186. All-or-
  nothing -- a half-discovered result fails rather than returning partial
  config the frontend would have to reason about.
- `cache.rs` -- SQLCipher-encrypted SQLite (`rusqlite`, `bundled-sqlcipher`)
  local mirror of mail data. The encryption key is a random 32-byte value
  kept in the OS keychain under a reserved sentinel name
  (`__local_cache_key__`) -- `get_or_create_cache_key` distinguishes
  `keyring::Error::NoEntry` from every other keychain error specifically so
  a transient keychain failure can never be mistaken for "no key yet" and
  silently mint a replacement that strands existing encrypted data. One
  connection per call, no pooling, no migration framework yet (single
  schema version so far). Tables: `cached_messages` (write-through from
  `imap.rs`'s fetch commands, best-effort -- failures are logged, never
  surfaced), `accounts` (see `account.rs` below), `contacts` (see below),
  `pgp_keys`/`pgp_contact_keys` (see `pgp.rs` below).
- `account.rs` -- `add_account` composes credentials + IMAP + cache: store
  the credential, verify it via `imap::list_folders`, persist connection
  metadata (host/port/folder names, never the password) via
  `cache::upsert_account`, rolling the credential back if either the
  verification or the persistence step fails. This is the pattern to follow
  for any future command that coordinates credentials with another step:
  never leave an unverified or unrecorded credential sitting in the
  keychain. Also exposes `list_accounts`/`remove_account` and
  `fetch_unified_inbox(limit)`, which fans `imap::fetch_messages` out across
  every stored account via `join_all`, skips (logs, doesn't fail) any
  account whose fetch errors, and merges by parsed RFC 3339 date -- never by
  raw string comparison, since two servers in different UTC offsets sort
  wrong that way.
- `pop3.rs` -- hand-rolled POP3 (RFC 1939) over `tokio_native_tls`, POP3S
  (port 995, implicit TLS) only, no STARTTLS/plaintext path, matching this
  codebase's no-insecure-connection-anywhere posture. `list_messages`/
  `fetch_message`/`delete_message`; `fetch_message` reuses
  `imap::parse_message_body`. Not integrated with the local cache or
  account model -- POP3 has neither folders nor a stable per-session UID
  model, so forcing it into `cached_messages`' `(account_id, folder, uid)`
  schema is a separate design problem, not solved yet.
- `pgp.rs` -- OpenPGP via the `pgp` (rpgp) crate, chosen over
  `sequoia-openpgp` specifically to avoid that crate's LGPL license (every
  other dependency here is permissive). `generate_keypair`/
  `import_own_key`/`export_public_key`/`import_contact_key` manage keys in
  `cache.rs`'s tables; `encrypt_and_sign`/`decrypt_and_verify`/
  `maybe_decrypt` are `pub(crate)` helpers wired into `smtp::send_message`
  (an `encrypt` flag that hard-fails the send if encryption fails -- never
  a silent plaintext fallback) and into `imap::fetch_message_body`/
  `pop3::fetch_message` (best-effort: a fetch with a body that isn't
  decryptable just comes back unchanged, still armored). Inline-armored PGP
  only, not PGP/MIME, in both directions -- blocked on outgoing mail being
  plain-text/non-multipart in the first place.

Contact harvesting (`cache::upsert_contacts`, a `contacts` table keyed by
lowercased email) happens at `imap::fetch_message_body` and
`smtp::send_message`'s call sites, not in `fetch_messages` -- opening or
sending a message is a real correspondence signal, showing up in a folder
listing is not.

No connection pooling or persistent IMAP/POP3 session exists anywhere --
every command call opens and closes its own connection, one DB connection
per cache call, same reasoning each place. That's intentional until there's
a real need for a long-lived session (e.g. IMAP IDLE-based push updates,
the biggest item still open in `backend-backlog.md`); don't add pooling
speculatively.

### Frontend <-> backend boundary

The frontend never handles raw passwords or PGP secret keys for stored
accounts. `src/lib/credentials.ts` is a thin `invoke()` wrapper around the
Rust commands; secrets go straight to the OS keychain (or the encrypted
cache, for PGP keys) via Rust and are never read back into JS except as
part of the one-time `store_credential` call during onboarding. Any new
Tauri command should preserve this: business logic and anything
secret-handling belongs in `src-tauri/src/`, not in the frontend.

### Testing conventions on the Rust side

Tests that need an external resource are marked `#[ignore]` and excluded
from the default `cargo test` run:
- Tests against real external servers (`imap.gmail.com`, `smtp.gmail.com`)
  only exercise the login/auth-failure path (no real credentials are
  committed), which is enough to prove the TCP/TLS/protocol-framing/
  keychain-lookup stack works end to end.
- The actual EXAMINE/FETCH/STORE/MOVE/SMTP-send/POP3 logic against real
  message data is exercised against a local GreenMail Docker container --
  see each feature's own doc (`imap-core.md`, `mailbox-actions.md`,
  `smtp.md`, `pop3.md`) for the exact docker invocation and seed script,
  since each needs a differently-seeded mailbox. PGP is the one exception:
  it's pure local cryptography (generate a keypair, encrypt-and-sign to
  itself, decrypt-and-verify), so its core logic is tested with no network
  or container at all -- only its GreenMail-based send/fetch round-trip
  test needs the container.
- There is also a real (non-mock) hosting-provider test mailbox available
  for manual, throwaway verification when GreenMail isn't sufficient --
  credentials live in a gitignored `.env` at the project root and must never
  be duplicated into committed code, tests, or docs. Any such check should
  read the env vars at runtime, run a scratch test, then remove it again.
  (This surfaced a real finding, not just a sanity check: that host
  supports neither IMAP `MOVE` nor `UIDPLUS`, exercising the SEARCH-based
  move fallback for real, and its SMTP service's certificate doesn't match
  its hostname, which `send_message` correctly refuses to send through --
  see `mailbox-actions.md`/`smtp.md`.)

Pure parsing/formatting logic with no external dependency (`decode_header_text`/
`format_address`/`parse_message_body` in `imap.rs`, `unstuff_multiline_response`
in `pop3.rs`, the provider table lookup in `discovery.rs`) has plain unit
tests that run in the default `cargo test` pass.

## Conventions specific to this project

- `docs/user/` (end-user facing: what Helix is, current status, how to run
  it) and `docs/technical/` (architecture, stack-choice rationale, setup,
  per-feature implementation notes) are living documentation, not a one-time
  setup artifact. When a feature, architecture decision, or setup step
  lands, update or add the relevant doc in the same change rather than
  leaving it to drift -- `docs/technical/backend-backlog.md` is the running
  checklist of backend work, and each backlog item gets its own doc once
  implemented, following the pattern of `credential-storage.md` /
  `imap-core.md` / `account-onboarding.md` / `multi-account.md` /
  `pgp.md` / `pop3.md`.
