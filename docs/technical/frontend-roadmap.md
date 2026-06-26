# Frontend roadmap

The frontend-side equivalent of `backend-backlog.md` -- one running
checklist of what's actually wired to a real backend command versus
still sample data or a UI placeholder, so this doesn't have to be
re-derived from scratch by reading every component again. Update this in
the same change that wires something new, the same convention
`backend-backlog.md` already uses. Checked items still note their real
caveats; this list is about wiring, not feature completeness.

## Core mail experience -- now real for IMAP accounts

The hardcoded `ACCOUNTS` constant and `SEED_MESSAGES_BY_KEY` sample data
are no longer what the live mailbox view reads. `useAccounts()` calls
`list_accounts` on mount and feeds the real persisted accounts into the
sidebar, message list, and all mutation handlers. The sample data in
`src/data/` still seeds `useMessageStore`'s initial state as a demo/dev
fallback (when no real accounts exist, the welcome screen shows; in
browser-only `npm run dev` mode the sample data is still visible).

- [x] Real account identity in the mailbox view -- `useAccounts()` in
      `src/hooks/useAccounts.ts` calls `list_accounts`, result flows into
      `Sidebar`, `MessageList`, `SettingsModal`, and `App.tsx`'s accent
      color / selected-account state. `ACCOUNTS` constant retired.
- [x] Real folder listing (`list_folders`) -- called in `App.tsx`'s
      `ensureFolders()` when an account is first activated; result stored
      in `foldersByAccount` state and threaded into `Sidebar`'s folder
      tree. Unknown IMAP folder names get a normalised label
      (`folderLabel()` / `normalizeFolderId()` in `data/folders.ts`) and
      a generic folder icon.
- [x] Real message fetch (`fetch_messages`) -- `loadFolder()` in
      `App.tsx` calls this whenever a folder is opened that has no cached
      messages. Summaries are mapped to `SampleMessage`-compatible
      objects via `summaryToMessage()` and fed into `useMessageStore`
      via the new `loadMessages()` method.
- [x] Real message body (`fetch_message_body`) -- called lazily when a
      message is selected and `bodyLoaded` is not yet set. Body fields
      (`textBody`, `htmlBody`, `realAttachments`, threading headers) are
      merged into the stored message via `updateMessageBody()`.
- [x] Real mailbox mutations (`set_message_seen`/`set_message_flagged`/
      `move_message_to_folder`) -- all three wired in `App.tsx`: opening
      a message calls `set_message_seen`, toggling the star calls
      `set_message_flagged`, and archive/spam/trash/move all call
      `move_message_to_folder` (resolving "archive"/"trash" to the
      account's configured folder names). All fire after optimistic local
      state update; failures are logged, not surfaced as hard errors.
- [x] Real send (`send_message`) -- `ComposeModal` now has an `onSend`
      prop; `App.tsx` wires it to `sendMessage()` from `src/lib/smtp.ts`.
      The Send button is real: shows "Sending...", surfaces errors inline,
      and only closes on success. File attachments are base64-encoded via
      `fileToBase64()` before the IPC call. Threading headers
      (`In-Reply-To`/`References`) are built by `handleReply`/
      `handleReplyAll` and passed through `ComposePrefill`.
- [ ] Real unified inbox (`fetch_unified_inbox`) -- the frontend-side
      merge in `useMessageStore.getUnifiedInbox()` already uses the real
      fetched messages once accounts are loaded; the backend
      `fetch_unified_inbox` command (which fans out via join_all) is not
      called directly yet. The end result is equivalent for now.
- [ ] Real contacts autocomplete (`search_contacts`) -- `AddressField`
      still calls `searchKnownAddresses` over the sample inbox. The real
      contacts table gets populated as real messages are opened (via
      `cache::upsert_contacts` in `fetch_message_body`), so this just
      needs a frontend caller once enough contacts have accumulated.
- [ ] Real attachment download -- `ReaderPane` now renders real
      `AttachmentInfo` from `fetch_message_body` with filename/type/size,
      but the Download button still calls `fetch_attachment` nowhere --
      the backend command is real, the frontend wiring is not yet.

## Account onboarding and management -- real

- [x] `AddAccountModal` calls the real `add_account` (verifies over a
      real IMAP login, persists connection metadata, rolls back on
      failure), auto-resolving IMAP/SMTP host+port via the previously-
      unwired `discover_server_config` unless "advanced" is expanded.
      Now opened from Settings > Accounts (`+ Add account`, next to the
      real list) rather than the sidebar footer -- see
      `account-onboarding.md`/`multi-account.md`.
- [x] Settings > Accounts' "Connected accounts" section
      (`ConnectedAccountsSettings.tsx`) lists the real, persisted
      accounts (`list_accounts`) with a real "Remove" (`remove_account`).
      Separate from the "Sample accounts" list above it, which is what
      the mailbox view actually reads from -- seeing an account here
      doesn't make it appear in the sidebar yet (see the section above).

## PGP / encryption -- key management real, message-level crypto not

- [x] Settings > Privacy & Security's key-management section
      (`PgpKeySettings.tsx`, via `src/lib/pgp.ts`) calls
      `generate_keypair`/`export_public_key`/`import_own_key`/
      `import_contact_key` for real, against the active (still sample)
      account's id.
- [~] Compose's Encrypt toggle -- the toggle state is now passed through
      to `send_message(encrypt: true)` via `onSend`. PGP encryption will
      actually fire if the user has a keypair in the cache and the
      recipient's public key is on file. The "encrypt by default" Settings
      toggle still defaults to `false` (was `true`) so new users don't hit
      a "no keypair" error on their first send.
- [x] `ReaderPane`'s Signed-by badge -- now driven by
      `pgp_signed_by`/`pgp_signature_valid` from real `fetch_message_body`
      output (via `updateMessageBody`), not just the hardcoded sample.
      PGP decryption happens in `pgp::maybe_decrypt` on the Rust side
      before the body reaches the frontend. The "Encrypted" badge still
      uses the sample message field (`encrypted`) -- `fetch_message_body`
      doesn't return a separate "was encrypted" flag, only the post-
      decryption text. See `encryption.md`.

## Reading experience -- real rendering, sample content

- [x] HTML message bodies render for real: `src/lib/sanitizeHtml.ts`
      (DOMPurify allowlist) feeding a sandboxed `<iframe>`
      (`HtmlMessageBody` in `ReaderPane.tsx`), including real
      remote-image blocking (strips/restores `<img src>`, not just a
      placeholder card). The HTML content itself is sample-authored, not
      fetched.
- [x] Multi-attachment rendering (`getAttachments`) -- real UI, sample
      data, no real download (see above).
- [x] Reply-All / Forward buttons in `ReaderPane`, building a real
      `ComposePrefill` (To/Cc/subject/body) the same way Reply already
      did. No real header construction (`In-Reply-To`/`References`) or
      recipient resolution -- and no real send underneath either way.
- [x] Templates/Quick Parts -- fully real, frontend-only (no backend
      involved at all). `ComposeModal`'s Templates button (`src/lib/`
      has no module for this; the `MessageTemplate` type lives in
      `ComposeModal.tsx` itself, persisted via `usePersistedJSON` in
      `App.tsx`) inserts a saved template or saves the current draft as
      a new one; Settings > Templates lists/deletes them.
- [x] Rules & auto-sorting -- a real condition/action engine
      (`src/lib/rules.ts`: `matchesRule`/`applyRules`, pure functions)
      wired into `useMessageStore.applyRules`, which calls the store's
      own real `moveMessage`/`markRead`/`setStarred`. Runs when landing
      on a folder/account (`App.tsx`) and from the message list's
      Refresh button (`onApplyRules`) -- not on a background timer,
      since there's no new-mail event in this app to hook into yet (see
      "Core mail experience" above). Settings > Rules
      (`RuleSettings.tsx`) manages the rule list. Real and fully working
      against the sample message store; the only thing not real is the
      "mail arrived" trigger, because nothing produces that event
      anywhere in this app yet.

## Settings -- full-screen, six new categories

Settings opens full-screen (`ModalOverlay`'s `fullScreen` prop) instead
of a small popup.

- [x] **Accounts** -- see above.
- [x] **Notifications** (`NotificationSettings.tsx`) -- real OS
      permission request/state and a real test notification via
      `@tauri-apps/plugin-notification` (new dependency this pass:
      `tauri-plugin-notification` in `Cargo.toml`/`lib.rs`,
      `notification:default` in `capabilities/default.json`). "Notify on
      new mail" is a persisted-but-inert toggle -- there's no
      new-mail-detection loop anywhere in this app (no IMAP IDLE, no
      polling) to trigger it.
- [x] **Data & Storage** (`DataStorageSettings.tsx`) -- real cache
      stats and a real, confirm-before-destructive "Clear cache"
      (`cache_stats`/`clear_cache`, two new backend commands this pass;
      clears `cached_messages` only, never accounts/contacts/PGP keys).
- [x] **Shortcuts** -- lists a small fixed (not yet rebindable) set of
      real, working Gmail-style shortcuts (`useKeyboardShortcuts.ts`):
      compose/reply/reply-all/forward/archive/trash/focus-search/
      open-settings. Inert while typing in a text field or while a modal
      is open.
- [~] **Appearance** -- accent-palette swatches are now real (clicking
      one sets the active account's color override, the same
      `accountOverrides`/`onUpdateAccountOverride` plumbing the sidebar's
      right-click menu already used). Typography samples and "dark mode
      only" stay informational, not settings.
- [x] **Templates** (in `SettingsModal.tsx` directly, no separate
      component file -- it's a simple list) -- real list/delete of
      Compose's saved templates, see "Reading experience" above.
- [x] **Rules** (`RuleSettings.tsx`) -- real rule list/create/edit/
      delete, see "Reading experience" above for what running a rule
      actually does.
- [ ] **Privacy & Security** (read receipts, block remote images) and
      **General** (compact list, unified inbox, signature) -- still
      local-only toggles/text, same as before this pass, apart from
      "block remote images" now having real HTML to act on (see above).
- [ ] **About** -- static info + external links, nothing to wire.

## Polish

- [x] Global themed scrollbar (`index.html`'s `<style>` --
      `::-webkit-scrollbar`/`scrollbar-color`, since RN's `StyleSheet`
      can't express scrollbar pseudo-elements) replacing the default OS
      white scrollbar everywhere the app scrolls.
- [x] Sidebar's remaining footer button (Settings) restyled: rounded
      chip, permanent (if subtle) icon tint, accent glow on hover --
      was a flat, edge-to-edge list row.

## Legend

`[x]` real backend call exists and is exercised from the UI. `[~]`
partially real (some interaction wired, some still informational).
`[ ]` sample data, local-only state, or no UI at all yet.
