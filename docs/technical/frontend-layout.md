# Frontend layout: responsive shell, virtualization, selection state

Covers the first pass of frontend layout work: a resizable, responsive
3-pane shell, a virtualized message list, and folder/account selection
that actually drives what the list and reader pane show. All of this is
still operating on sample data (see `src/data/messages.ts`) -- there is no
backend sync wired into the UI yet.

## Resizable splitters

`src/components/Splitter.tsx` is a plain `<div>` drag handle (not an RN
`View` -- see `architecture.md`'s react-native-svg note for why raw DOM is
used for web-only interaction code in this codebase). On `pointerdown` it
captures the starting cursor X, then tracks `pointermove`/`pointerup` on
`window` rather than the element itself, so the drag doesn't break if the
cursor outruns the 4px-wide hit target.

`Splitter` only reports a delta-since-drag-start; it has no opinion about
bounds. `App.tsx` owns the actual pane widths (`sidebarWidth`, `listWidth`)
and clamps them:

- Sidebar: 180-360px
- Message list: 280-520px
- Reader pane has no explicit min -- it's `flex: 1`, and the breakpoint
  collapse (below) kicks in before the shell gets too narrow for it to be
  usable

Both widths persist across reloads via `usePersistedState`
(`src/hooks/usePersistedState.ts`), a numeric-only localStorage-backed
`useState` replacement under keys `helix:sidebarWidth` / `helix:listWidth`.
It's deliberately not a generic JSON-serializing store -- generalize it if
a second kind of value needs persisting.

## Responsive breakpoints

`src/hooks/useBreakpoint.ts` wraps `useWindowDimensions` into three named
breakpoints:

- **Desktop (>=1080px):** all three panes, both splitters active.
- **Tablet (720-1079px):** sidebar collapses to a dismissable overlay
  (`Sidebar`'s `overlay`/`onDismissOverlay` props -- same component, just
  rendered absolutely with a backdrop instead of inline), toggled by a
  corner button in `App.tsx`. List and reader stay side by side with a
  splitter between them.
- **Mobile (<720px):** a single pane at a time. Selecting a message
  switches from list to reader (`App.tsx`'s `handleSelectMessage`);
  `ReaderPane`'s `onBack` prop (only passed in this mode) switches back.
  The sidebar is overlay-only here too, via the same corner button.

`App.tsx` resets `mobileView` to `"list"` and closes the sidebar overlay
when the breakpoint changes away from mobile/desktop respectively, so a
resize doesn't strand the UI mid-reader-view or with a stale open drawer.

Sidebar collapses before the message list does, on the reasoning that
losing persistent folder-tree visibility is recoverable with one tap and
no lost context, while losing the reader pane mid-read is more disruptive.

## Virtualized message list

`MessageList` renders through `FlatList` (`react-native-web`'s built-in
virtualization, no new dependency) instead of a plain `.map()`. The
per-row JSX is unchanged -- it's just `renderItem` now instead of a map
callback -- so hover/selected/compact/unread styling all behave exactly as
before. No tuning props (`windowSize`, `initialNumToRender`) are set;
revisit once real IMAP fetch sizes are known.

## Lifted selection state

`selectedFolder: Record<Accent, string>` now lives in `App.tsx` (mirroring
how `accent` already worked), not as local state inside `Sidebar`. Folder
clicks call `onFolderChange(account, folder)`, which updates `accent`,
`selectedFolder`, and resets `selectedId` to the new folder's first message
in one place, instead of the two separate calls `Sidebar` used to make
itself. `Sidebar`'s `expanded` (which account's folder list is visually
open) stays local -- nothing outside `Sidebar` needs to read it.

Sample data moved out of `MessageList.tsx`/`ReaderPane.tsx` into
`src/data/messages.ts`, keyed by `"<account>:<folder>"`
(`getMessagesFor`/`findMessage`/`findMessageIndex`), plus `getBody`/
`getAttachments` keyed by message id. Only `cyan:inbox` and `purple:inbox`
have real sample content; every other folder renders empty via a `?? []`
fallback rather than needing twelve hand-written fake datasets. Folder
metadata (id/label/glyph -- though glyphs are no longer used now that
`FolderIcon` renders real icons) lives in `src/data/folders.ts`, shared
between `Sidebar` and `MessageList`'s header label.

`ReaderPane` now takes a `folder` prop and looks up its message via
`findMessage(accent, folder, selectedId)` rather than importing
`MessageList`'s old flat array and searching it directly -- IMAP UIDs are
only unique within a folder, not across an account, so a folder-scoped
lookup is the one that won't quietly break once real data arrives.

## Sidebar icons and animation

Folder rows use `src/components/FolderIcon.tsx` (hand-drawn line-art SVG,
same plain-DOM reasoning as `Splitter`) instead of the old two-letter
glyphs. The account row's folder-list expand/collapse is animated via a
CSS `transition` on `max-height`/`opacity` (the `WebViewStyle` shim in
`src/lib/webStyle.ts` now also widens `transition`, alongside
`backdropFilter`/`filter`) rather than an instant conditional mount, so the
folder list slides rather than snapping.

The sidebar footer's "Add account" / "Settings" rows (`SidebarFooterButton`,
defined in `Sidebar.tsx`) follow the same `transition`-on-hover idea: the
icon tint, icon chip background, and top border all ease toward the active
account's accent color on hover (via local `hovered` state rather than
Pressable's style-callback `hovered`, since the icon color itself needs to
change, not just the wrapping `View`'s style), plus a small `scale` dip
while pressed.

## Accounts are no longer pinned to a fixed 2-color enum

`Accent` used to be `"cyan" | "purple"` and doubled as both account
identity and a literal key into `colors.accent` -- meaning the app could
never have more than two accounts no matter what `ACCOUNTS` contained.
`AccountId` (`src/theme/colors.ts`, an alias for `string` -- the account's
email) replaced it as the identity; color is now assigned via
`colorForIndex(an account's position in ACCOUNTS)`, the same
rotating-palette mechanism already used for folders/senders/avatars. Every
component that used to take an `accent: Accent` prop now takes
`accentColor: string` (already resolved by whoever owns the data, usually
`App.tsx`) plus, where the component actually needs identity rather than
just a color (`Sidebar`, `MessageList`, `SettingsModal`), an `accountId:
AccountId` prop too. `ACCOUNTS` (`src/data/accounts.ts`) now seeds 5 sample
accounts rather than 2, specifically so a 2-account assumption can't creep
back in unnoticed.

Per-account label/color can be further overridden by the user (right-click
an account in the sidebar -- see below); `resolveAccountColor`/
`resolveAccountLabel` in `data/accounts.ts` are the one place that decides
override-vs-default, so `Sidebar`/`SettingsModal`/`MessageList`/`App.tsx`
can't drift out of sync on what "this account's color" means.

### Sidebar account context menu

Right-clicking an account row (`Sidebar.tsx`) opens a small menu --
rename, or pick a new color from `accentCycle` -- backed by
`usePersistedJSON` (`src/hooks/usePersistedState.ts`, the generic
JSON-serializing sibling of the original numeric-only `usePersistedState`,
storing `Record<AccountId, { label?: string; color?: string }>` under
`helix:accountOverrides`). The menu anchors to the raw `contextmenu` DOM
event's `clientX`/`clientY` (a plain `<div onContextMenu={...}>` wrapper,
not `useAnchorRect`) rather than to the row's own position, since a
context menu opens wherever the cursor right-clicked and needs to
re-anchor immediately if a different row is right-clicked while one is
already open -- `useAnchorRect`'s ref-based measurement only re-fires on
open/close, not on the anchor target changing identity while already open.

The rename `TextInput` is `autoFocus`ed but deliberately has no
`onBlur`-commits-rename handler -- clicking a color swatch or "Reset to
default" in the same menu blurs the focused input *first* (standard
browser focus-change order), so committing on blur would re-save the
rename draft right after the swatch/reset's own update already landed,
silently clobbering whichever field that click was actually for. Enter
(`onSubmitEditing`) is the only commit path for the rename field.

## Unified inbox and blocked remote images

Settings' "Unified inbox" toggle (state lifted to `App.tsx` alongside
`compactList`/`encryptByDefault`) switches `MessageList`'s `messages` from
the open account's open folder to `useMessageStore.getUnifiedInbox()` --
every account's Inbox merged, each message tagged with its own `folder`
and `accountId` (`MessageWithFolder` grew an `accountId` field for this).
Rows show a small colored badge with the account's label whenever a
message isn't from the currently-active account (reusing the same badge
styling as cross-folder search results), and selecting one switches both
`accountId` and `selectedFolder` to match before opening it -- the same
"switch context to wherever the row actually lives first" pattern search
selection already used, just extended to cover account as well as folder.
The search box also broadens to `getEverything()` (every folder of every
account) while Unified inbox is on, rather than just the active account's
folders.

Row-level actions split into two paths because of this: `ReaderPane`'s
star/archive/etc. always act on whatever's currently open (so they can
keep using `accountId`/`selectedFolder[accountId]` from `App.tsx` as-is),
but `MessageList`'s own row-level star button needed a version that takes
the row's `accountId`/`folder` explicitly (`handleToggleStarInList` vs.
`handleToggleStar` in `App.tsx`) -- a Unified Inbox row can belong to a
different account than whatever's "active", and the row star button
doesn't switch the active account/folder the way clicking the row itself
does.

Settings' "Block remote images" toggle has something real to act on now:
one sample message (`hasRemoteImage` on `SampleMessage`, the "Your storage
is almost full" ProtonMail message) renders either a "Remote image
blocked" banner with a "Show images" override (resets per message, not
sticky), or the message's real HTML body with its remote `<img>`s
actually loading (see "HTML message bodies" below for how blocking
itself works) -- the email content is real HTML, just sample-authored
rather than fetched.

## Floating menus: why they're portaled

Every `react-native-web` `View` is `position: relative` with an *implicit*
`zIndex: 0` (visible in devtools even when no style sets one) -- and per
the CSS spec, a non-auto `z-index` on a positioned element creates a new
stacking context. The practical effect: every single `View` in this app is
its own isolated stacking context. A descendant several levels deep that
sets a high `zIndex` only ever wins against *its own siblings inside that
one nested box* -- it can never out-rank an unrelated element several
boxes further up the tree, no matter how high the value is, because each
intermediate box's own ranking (its implicit `0`) is all that's visible
from the outside.

This first showed up as a real bug: the message list's "Newest/Oldest"
sort menu rendered underneath the search bar, and the custom date range
picker's month/year `Dropdown` rendered underneath the "Clear filters"
button -- both several `View`s deep inside containers with no special
`zIndex` of their own, fighting unrelated later siblings that were just as
deeply nested on the other side.

The fix is `src/components/FloatingPortal.tsx` + `src/hooks/
useAnchorRect.ts`, used together: `useAnchorRect(open)` measures a trigger
element's `getBoundingClientRect()` (re-measuring on resize/scroll while
open), and `FloatingPortal` renders its children via `react-dom`'s
`createPortal` straight onto `document.body` at fixed viewport coordinates
derived from that rect -- bypassing every intermediate stacking context
instead of trying to out-rank them. It optionally renders a full-viewport
invisible backdrop first (`onDismiss`) so outside-click-to-close doesn't
need separate wiring per caller. Current consumers: `Dropdown`'s month/
year menu, `MessageList`'s sort menu, and `AddressField`'s suggestion list.

This is web/Tauri-only, same reasoning as `Splitter`'s raw `<div>` --
there's no portal or CSS-stacking-context concept to port when this ships
on native, since native view hierarchies don't have this problem.

One related gotcha specific to `Pressable`: its hover gesture hardcodes
`contain: true`, meaning hovering a *nested* `Pressable` suppresses any
ancestor `Pressable`'s own hover state. `src/components/Tooltip.tsx` (hover
labels for icon-only controls) wraps its trigger in a plain `<div>` with
native `onMouseEnter`/`onMouseLeave` rather than an outer `Pressable`, for
exactly this reason -- an outer `Pressable` around an inner one (e.g. a
toolbar button) would simply never see its own hover fire.

The message list's filter panel (below) does *not* use `FloatingPortal` --
it only ever needs to out-rank its own direct siblings inside one `header`
View (a shallow, single-level comparison), so a plain `zIndex` is enough
there. Portal vs. plain `zIndex` comes down to how many stacking contexts
are between the floating element and whatever it needs to beat.

## Message list: search, filters, sort, and refresh

The filter panel (`MessageList`'s filter toggle, next to the search box)
is anchored to the top of the pane's `header`, not below the search row --
it pops upward and overlaps the search bar (and the title/sort row above
it) rather than dropping down and covering the first rows of the message
list. Because it now fully covers the toggle button that opened it, the
panel has its own "Filters" title + close (×) control; relying solely on
re-clicking the (now-hidden) toggle would leave no visible way to close it
without clicking elsewhere first.

The search box and the From/To/Date filter panel have different scope.
Typing in the search box searches every folder in the current account
(`useMessageStore.getAllMessages`, every folder's messages tagged with
`folder: string`), not just the open one -- results from a different
folder than the one currently open show a small folder-name badge next to
the sender. The From/To/Date filter panel stays scoped to the open folder
even while a search query is active; only the text query broadens scope.
Selecting a cross-folder result switches `selectedFolder[accent]` to match
(`App.tsx`'s `handleSelectMessage`) before setting `selectedId`, since
`markRead`/`findMessage`/`findMessageIndex` all key off `selectedFolder`.

The refresh button next to the sort control plays a loading-spinner
animation (RN's `Animated`/`Easing`, looped while `refreshing` is true) for
about a second and then stops -- there is no real fetch behind it.
`fetch_messages`/`fetch_unified_inbox` already exist as real Tauri
commands (see the per-feature docs in `docs/technical/`), but nothing in the frontend calls
them yet, and wiring that up means first giving the frontend a concept of
a real `account_id` (today's "active account" is just the `Accent` color
key), which doesn't exist yet either. Treat this the same as the sample
message data generally -- a placeholder for the real thing, not a stand-in
that's trying to look more finished than it is.

## Compose modal: resize, minimize, and address chips

`ComposeModal` is resizable (drag the card's top-left corner -- it's
docked to the bottom-right of the screen, so growing it means moving that
corner up and left, the only direction available) and minimizable (collapses
to just the header bar; the title swaps to show the subject once one's been
typed). Both width and height persist across reloads via `usePersistedState`
(`helix.compose.width` / `helix.compose.height`), the same hook the sidebar/
list splitters use. Minimizing covers the original toggle's hit area, so
the header carries an explicit close (×) affordance in addition to the
minimize/expand chevron -- same reasoning as the filter panel above.

The body textarea fills whatever vertical space is left after the
fixed-height header fields/toolbar/attachments (`flex: 1` on both the
form-area wrapper and the textarea itself, replacing the old `ScrollView`-
wraps-everything layout that gave the body a fixed `minHeight` regardless
of how tall the card was), so resizing the card taller actually gives you
more room to write rather than more empty space around a fixed-size box.

To/Cc/Bcc (`src/components/AddressField.tsx`) hold multiple recipients as
removable chips rather than one plain string -- typing a comma or pressing
Enter commits the current text as a chip; Backspace on an empty draft
removes the last one. Each field also offers autocomplete suggestions
(`searchKnownAddresses` in `src/data/messages.ts`, deduped senders from the
sample inbox -- a real address book doesn't exist yet, though
`search_contacts` already exists server-side per `contacts.md`, same
not-yet-wired caveat as the refresh button above) via `FloatingPortal`.
Selecting a suggestion uses `onMouseDown` + `preventDefault()` rather than
a normal press handler: a click on the suggestion first blurs the (still
focused) text input, and the input's `onBlur` handler is what closes the
suggestion list -- by the time a click/press event would otherwise fire,
the row has already unmounted. `preventDefault` on `mousedown` stops the
focus shift, and so the blur, from happening at all.

The toolbar's Attach button is visually split from the formatting buttons
(its own paperclip icon, past a divider) since it's the one real action in
that row -- the rest are unwired formatting placeholders (see the comment
above `FORMATTING_BUTTONS`). All of the toolbar buttons, plus Attach,
minimize, and close, show a small hover tooltip (`src/components/
Tooltip.tsx`) using each button's existing label.

## HTML message bodies, attachments, reply-all/forward, and PGP key settings

A second pass on the reading experience, still entirely against sample
data (`src/data/messages.ts`) -- no real `fetch_message_body`/
`send_message` call exists from the frontend yet, see
the per-feature docs in `docs/technical/`.

**HTML rendering.** One sample message now has a real HTML body
(`getHtmlBody`/`HTML_BODY_BY_ID`) instead of plain text. `ReaderPane`
sanitizes it through `src/lib/sanitizeHtml.ts` (a `dompurify`-backed
allowlist -- tags/attributes not explicitly permitted are dropped, links
are forced to `target="_blank" rel="noopener noreferrer"`) and renders
the result inside a sandboxed `<iframe srcDoc=...>` (`HtmlMessageBody`,
defined in `ReaderPane.tsx`), not a plain div with
`dangerouslySetInnerHTML`. The sandbox (`allow-same-origin allow-popups`,
deliberately *not* `allow-scripts`) is a second, independent containment
layer beyond the sanitizer -- it also keeps any inline CSS in the email
body scoped to its own document instead of able to leak out and affect
the rest of the app, which a plain div can't guarantee. `allow-same-origin`
is there so the component can read `contentDocument.body.scrollHeight` on
load and resize the iframe to fit; since `allow-scripts` is never set,
nothing in the email body can actually execute regardless. Toggling
Settings' "Block remote images" (or the per-message "Show images"
override) re-sanitizes with `blockRemoteImages` true/false, which strips
(and restores) `<img>` `src` attributes rather than touching anything
about the iframe itself.

**Attachments.** `getAttachments` returns every attachment for a message
(was capped at one). `ReaderPane` renders one card per attachment with a
disabled "Download" control (`Tooltip`-wrapped, explaining why). The
backend command this would call (`imap::fetch_attachment`/
`pop3::pop3_fetch_attachment`) is real and landed mid-session, but it
needs a real `account_id`/`host`/`port`/`folder`/`uid` -- none of which
exist for this sample data, so the button stays disabled for a frontend
reason now, not a backend one. `MessageList`'s row preview still only
shows the first attachment's name; a "+N more" treatment there is future
work, not done here.

**Reply-All / Forward.** `ReaderPane` gained two buttons next to Reply.
Both build a `ComposePrefill` (now also carrying an optional `cc`) the
same way Reply already did -- Reply-All adds the sample message's `cc`
field (one extra participant, just enough to make it visibly different
from Reply); Forward leaves `to` empty and formats the original message
as a labeled block (`---------- Forwarded message ---------` + headers)
instead of quoting it with `> `. Neither does real header construction
(`In-Reply-To`/`References`) or recipient resolution -- see
the per-feature docs in `docs/technical/`'s Reply/Reply-All/Forward item.

**PGP key management.** `SettingsModal`'s Privacy & Security category now
mounts `src/components/PgpKeySettings.tsx`, which is real: it calls
`src/lib/pgp.ts`'s wrappers around `pgp.rs`'s
`generate_keypair`/`export_public_key`/`import_own_key`/
`import_contact_key` commands directly, the same one-real-call-in-an-
otherwise-sample-app pattern `AddAccountModal` already established for
`store_credential`. It operates on the active (still hardcoded)
`ACCOUNTS` entry's id as the `account_id`. There's no command to list
previously-imported contact keys, so that section only shows what's been
imported in the current session. See `docs/technical/encryption.md` for
exactly what is and isn't wired around PGP.

## Settings: full-screen, and four new real sections

Settings moved from a small centered popup (`ModalOverlay`'s default
`width`) to nearly the whole window: `ModalOverlay` gained a
`fullScreen` prop (`cardFullScreen` style, 97%/95% of the viewport)
that `SettingsModal` opts into; every other `ModalOverlay` consumer
(`AddAccountModal`) is unaffected, since `fullScreen` defaults to false.
`SettingsModal`'s `body` style switched from a fixed `minHeight: 480` to
`flex: 1`/`minHeight: 0` so its content actually fills the new space
instead of leaving most of the screen blank.

That extra room is filled with four new categories, three of which call
a real Tauri command (the fourth, Shortcuts, is real in the sense that
the shortcuts it lists actually fire):

- **Accounts** gained a "Connected accounts" section below the existing
  sample list (`src/components/ConnectedAccountsSettings.tsx`) -- a real,
  persisted account list via `list_accounts`, with a real "Remove"
  (`remove_account`). `AddAccountModal` itself was upgraded from calling
  `storeCredential` to the real `add_account`, auto-resolving server
  settings via the previously-unwired `discover_server_config` unless
  "advanced" is expanded. See `docs/technical/multi-account.md`.
- **Data & Storage** (`src/components/DataStorageSettings.tsx`) shows
  real cache stats and a real, confirm-before-destructive "Clear cache"
  (two new backend commands, `cache_stats`/`clear_cache`, added this
  pass -- see `docs/technical/local-cache.md`).
- **Notifications** (`src/components/NotificationSettings.tsx`) calls
  the real `@tauri-apps/plugin-notification` (new dependency --
  `tauri-plugin-notification` on the Rust side, registered in `lib.rs`,
  granted `notification:default` in `capabilities/default.json`) for
  permission state and a real test notification. "Notify on new mail"
  stays an inert, persisted toggle -- there's no new-mail-detection loop
  anywhere in this app (no IMAP IDLE, no polling) for it to hook into.
- **Shortcuts** lists a small fixed (not yet rebindable) set of
  Gmail-style single-letter shortcuts, real per `src/hooks/
  useKeyboardShortcuts.ts` -- one global `keydown` listener, same shape
  as `useEscapeKey.ts`, inert while typing in a text field or while a
  modal is open. Compose/reply/reply-all/forward/archive/trash/focus-
  search/open-settings. Focusing the search box needed a small new prop
  on `MessageList` (`focusSearchSignal`, a counter App.tsx bumps so two
  presses in a row both register) since its search `TextInput` wasn't
  previously reachable from outside the component.

`src/components/settingsStyles.ts` (new) holds the section-title/hint/
button/setting-row styles shared by these new components -- pulled out
once a fourth file would otherwise have copy-pasted the same styles a
fourth time. `SettingsModal.tsx`'s own inline categories (Appearance,
Privacy & Security, General, About) still use their original local
copies of some of these -- not yet migrated, left as a known follow-up
rather than risking a drive-by visual regression in already-working
code.

## Deferred to later phases

Not part of this pass -- listed here so a future contributor doesn't read
this doc as the final state of the frontend:

- Command palette (Cmd/Ctrl+K) and global keyboard shortcuts
- Swipe gestures on list rows
- Loading skeletons and an offline/sync banner
- Optimistic UI for archive/delete/move (blocked on backend mutation
  commands, which don't exist yet -- see the per-feature docs in `docs/technical/`)

## Custom title bar and window chrome (added later)

Native window decorations are off (`"decorations": false` in
`tauri.conf.json`); `src/components/TitleBar.tsx` is the window chrome.
One bar carries, left to right: the browser-style tab strip (moved here
from the old `TabBar.tsx`, now deleted -- tabs use `flexBasis: 200` with
`flexShrink: 1` and a `minWidth` floor so they shrink evenly like browser
tabs instead of overflowing), a `data-tauri-drag-region` filler div (drag
to move, double-click to maximize -- it must be a raw `div`, the
attribute only applies to the element itself), the mail search box +
filter-panel button + refresh button (moved out of `MessageList`'s
header; the `MessageFilters` state lives in `App.tsx` now, edited by the
title bar and applied by the list), and the min/max/toggle-maximize/close
window controls (via `getCurrentWindow()`, permissions added in
`src-tauri/capabilities/default.json`). The bar renders on the welcome
screen too -- with decorations off it's the only way to move or close the
window. Ctrl+Tab / Ctrl+Shift+Tab cycle tabs via a raw keydown listener
(deliberately not `useKeyboardShortcuts`, which is inert while typing).
The sort menu was reduced to Newest/Oldest, and the message list hides
its scrollbar (`showsVerticalScrollIndicator={false}`) because the
overlay bar painted exactly over each row's star button.

## Message-list sections and text size (added later)

Settings > General's "Separate unread from read" groups the list into an
Unread section above a Read section (labels render only when both groups
exist; skipped in conversation view where a thread mixes both). Settings
> Appearance's text size is a whole-UI zoom (`document.body.style.zoom`,
persisted as `helix:fontScale`) -- react-native-web styles are px-based,
so rem-scaling can't reach them. Settings themselves are staged: the
modal edits a local draft of `SettingsValues` and nothing applies until
Save (stays open) or Done (closes); any other close discards the draft.
