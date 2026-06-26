# Contact / address cache

A local address book that builds itself up from addresses seen in mail
the user reads or sends, for compose-time autocomplete.

## Storage

One `contacts` table in the same encrypted local cache as everything
else (`src-tauri/src/cache.rs`, see `local-cache.md`): `email` (primary
key), `display_name`, `last_seen_at`. It's a single address book shared
across every account rather than siloed per account -- autocomplete
wants "everyone I've ever corresponded with," not a separate list per
mailbox.

- `cache::upsert_contacts(conn, &[(email, display_name)])` -- one
  transaction per batch, same shape as `upsert_summaries`. Email
  addresses are lowercased before storing, since mailboxes are
  conventionally case-insensitive and without this `"Foo@x.com"` and
  `"foo@x.com"` would dedupe as two different contacts. A sighting with
  no name (a bare envelope address, common on `To`/`Cc` headers) never
  blanks out a name already known for that address -- `display_name =
  COALESCE(excluded.display_name, contacts.display_name)` keeps the
  existing name unless the new sighting actually has one.
- `cache::search_contacts_in(conn, query, limit)` -- the actual
  autocomplete read path (`WHERE email LIKE ... OR display_name LIKE ...
  ORDER BY last_seen_at DESC`). `%`/`_` are stripped from `query` first so
  user input can't be read as extra SQL `LIKE` wildcards. Exposed as the
  `#[tauri::command] search_contacts` wrapper.
- `cache::list_contacts_in(conn, limit)` -- lists the whole address book
  most-recently-seen first, for a contact-management view rather than
  compose-time autocomplete. Exposed as `list_contacts`.
- `cache::delete_contact_in(conn, email)` -- removes one harvested contact
  (email lowercased to match storage; deleting a missing one is a no-op
  success). Exposed as `delete_contact`. Since the address book
  accumulates automatically from every message read or sent, this is the
  only way to forget a one-off correspondent or a mistyped address that
  would otherwise linger in autocomplete forever.

## Where contacts get harvested from

Not from `imap::fetch_messages`/`fetch_recent_messages` -- that would
mean changing `MessageSummary`'s shape (used by several already-tested
call sites) for a different concern, and a folder listing is a weaker
signal of "I corresponded with this person" than actually opening or
sending a message. Two trigger points instead:

- **`imap::fetch_message_body`**: the already-parsed `mail_parser::Message`
  exposes `.from()`/`.to()`/`.cc()` (each `Option<&Address>`, flattened
  via `Address::iter()` into `Addr`s with `.address()`/`.name()`).
  `fetch_body_by_uid` returns `(MessageBody, Vec<(String,
  Option<String>)>)` now -- the second element is exactly these
  candidates, extracted by `extract_contact_candidates`. Opening a
  message to read it is a real "I interacted with this address" signal
  for the sender and every other recipient on the thread, not just the
  sender.
- **`smtp::send_message`**: the recipient the user just composed to.
  `to` is parsed once into a `lettre::message::Mailbox` (previously
  parsed inline and discarded); its `name`/`email` are reused for the
  contact upsert instead of parsing `to` a second time, and only after
  the send actually succeeds -- a failed send isn't a real signal of
  correspondence.

Both call sites cache best-effort: `cache::open()` +
`cache::upsert_contacts(...)`, failures logged via `log::warn!`, never
surfaced as a command failure. Same posture as the message cache's
write-through in `imap.rs`.

## What this doesn't do yet

- No frontend wiring -- `search_contacts` exists as a command, nothing
  calls it from the UI yet. Compose's To/Cc/Bcc autocomplete
  (`src/components/AddressField.tsx`) is a separate, sample-data-only
  lookup (`searchKnownAddresses` in `src/data/messages.ts`, sourced from
  the sample inbox) standing in for this command until there's a real
  `account_id` flowing through the frontend to call it with -- it doesn't
  read from or write to this cache at all.
- No contact merging/dedup beyond the case-insensitive email key --
  someone who sends from two different addresses shows up as two
  contacts.
- No ranking beyond "most recently seen first" (e.g. frequency-weighted
  autocomplete).
