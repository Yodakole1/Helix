# Message threading

`src-tauri/src/imap.rs` exposes `fetch_threaded_messages` and the
underlying `group_into_threads` function, which group a folder's messages
into conversation trees using `Message-ID` / `In-Reply-To` matching.

## What changed in MessageSummary

`MessageSummary` gained two fields, populated from IMAP's ENVELOPE
response (which is already fetched by `fetch_messages`, so no extra round-
trip needed):

- `message_id: Option<String>` -- the message's own `Message-ID`, angle
  brackets stripped, so it compares equal to what `mail_parser` returns
  from a full body fetch.
- `in_reply_to: Option<String>` -- the `In-Reply-To` header value (angle
  brackets stripped), pointing at the parent message's ID.

IMAP ENVELOPE includes both headers (RFC 3501 defines them as part of the
envelope structure). `References` is not in ENVELOPE, but `In-Reply-To`
alone is sufficient to build a correct parent-child tree for messages
within one folder fetch.

## Threading model

### Data structures

```rust
pub struct ThreadedMessage {
    pub message: MessageSummary,
    pub replies: Vec<ThreadedMessage>,
}
```

A `Vec<ThreadedMessage>` is the thread list for a folder -- each element
is a conversation root, carrying its full reply tree recursively.

### Algorithm (`group_into_threads`)

1. Build a `HashMap<&str, usize>` from `message_id` to array index.
2. For each message, look up its `in_reply_to` in the map to find its
   parent's index. Messages with no `in_reply_to`, or whose parent isn't
   in this fetch window, have `parent_of[i] = None` (they become roots).
3. Build a children list: `children[parent_idx]` = indices of that
   parent's direct replies.
4. Consume each `MessageSummary` from an `Option` slot exactly once via
   recursive `build_thread`, starting from root indices.
5. Sort roots and replies at each level by `date` (ascending,
   chronological order -- oldest first at every level).

### Edge cases

- **Orphaned replies** (parent outside the fetch window): become roots.
- **Messages with no `Message-ID`**: can't be identified as parents; any
  message whose `in_reply_to` matches them will also become a root.
- **Cycles** (A replies to B, B replies to A): both messages have parents
  in the set, so neither becomes a root and both are silently dropped.
  This can't happen in real RFC 5322 mail.

### Pure function, no network

`group_into_threads` is a synchronous, pure function that takes
`Vec<MessageSummary>` and returns `Vec<ThreadedMessage>`. It can be
called from any context that already has a flat message list, including
from the unified inbox (`account.rs`) if a threaded unified view is
wanted later.

## Tauri command: `fetch_threaded_messages`

Same interface as `fetch_messages` (same parameters: `account_id`, `host`,
`port`, `folder`, `limit`), but returns `Vec<ThreadedMessage>` instead of
`Vec<MessageSummary>`. The flat list is still written to the local cache
before grouping, same as `fetch_messages` does.

## What this doesn't do

- **Cross-folder threading**: only messages in the same fetch window
  (same folder, same call) can be threaded. A reply that's been moved to
  a different folder won't appear as a child of its parent.
- **References chain**: `References` (the full ancestor chain) isn't
  parsed from ENVELOPE. In practice, `In-Reply-To` alone handles the
  common linear reply chain correctly; `References` would help in cases
  where the direct parent isn't in the fetch window (e.g. a reply thread
  starting outside the `limit` window), which this treats the same way as
  orphaned replies: the reply becomes its own root.
- **Frontend wiring**: now done. A Settings > General "Conversation view"
  toggle switches `App.tsx`'s `loadFolder` to `fetch_threaded_messages`;
  `buildThreadData` flattens the returned tree into store rows plus a
  `ThreadMeta` grouping that `MessageList` re-applies to show one row per
  conversation with replies expandable. Off in the unified inbox and while
  searching; a threaded fetch that fails falls back to the flat path. See
  the per-feature docs in `docs/technical/`.

## Verification

Four pure unit tests (no network, no GreenMail needed) in `imap.rs`:

- `group_into_threads_builds_a_linear_reply_chain` -- three chained
  messages collapse into one thread with correct nesting depth.
- `group_into_threads_keeps_unrelated_messages_as_separate_roots` -- two
  independent messages produce two roots with no replies.
- `group_into_threads_treats_orphaned_replies_as_roots` -- a reply whose
  parent isn't in the set becomes a root.
- `group_into_threads_sorts_roots_and_replies_by_date` -- replies within
  a thread are ordered chronologically, not by fetch order.
