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
`getAttachment` keyed by message id. Only `cyan:inbox` and `purple:inbox`
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

## Deferred to later phases

Not part of this pass -- listed here so a future contributor doesn't read
this doc as the final state of the frontend:

- Command palette (Cmd/Ctrl+K) and global keyboard shortcuts
- Swipe gestures on list rows
- Loading skeletons and an offline/sync banner
- Optimistic UI for archive/delete/move (blocked on backend mutation
  commands, which don't exist yet -- see `backend-backlog.md`)
- Sandboxed iframe rendering for HTML email bodies, and dark-mode
  inversion for email content
