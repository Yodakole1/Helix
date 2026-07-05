# Mail import and bulk export

People switching clients arrive with archives; people backing up (or
leaving) need their mailbox back out as files. `src-tauri/src/mailstore.rs`
covers both directions in the two formats everything speaks: **mbox**
(one file, many messages -- Thunderbird's store format and what Google
Takeout produces) and **EML** (one RFC 5322 message per file). The UI
lives in Settings > Data & Storage > Import & export
(`src/components/ImportExportSettings.tsx`), using the dialog plugin for
file/directory pickers -- archives run to gigabytes, so file *paths* go
over IPC and Rust does the reading/writing, never the webview.

## Import

`import_mbox` / `import_eml_files` APPEND into a chosen folder on the
IMAP server over one session -- deliberately not into the local cache:
the server copy is the source of truth everywhere else in this codebase,
and a cache-only import would vanish on the next cache clear and never
reach the user's other devices. Consequences:

- IMAP-only. POP3 has no APPEND and no folders; those accounts get a
  clear error (`reject_pop3`) instead of a half-baked local
  approximation.
- Messages are APPENDed `\Seen` -- an archive is by definition mail that
  was already dealt with, and 40,000 suddenly-unread messages is the
  classic bad import experience.
- Failures are counted per message, not aborted on: one malformed
  message in a ten-year archive shouldn't strand the rest. The result
  carries `imported`, `failed`, and the first error string so the UI can
  say *why*. The exception is a framing (parse) error before anything
  imported -- that means the file isn't mbox at all and fails loudly.

### The mbox dialect

`MboxReader` streams -- one message in memory at a time. A `From ` line
following a blank line (or opening the file) is a separator; anything
else is content. mboxrd-flavored unstuffing: one `>` is stripped from
`^>+From ` lines on read, and the writer prepends one on write, so our
own files round-trip byte-exactly (there's a unit test asserting it) and
Thunderbird/Takeout files read correctly. Messages are CRLF-normalized
on read because IMAP APPEND requires CRLF (RFC 3501); a file that
doesn't start with a `From ` separator is rejected as not-mbox.

## Export

- `export_folder_mbox`: one folder -> one mbox file.
- `export_account_mbox`: full-mailbox backup -- every folder to
  `<dir>/<folder>.mbox` (folder names sanitized for cross-OS filename
  rules), unopenable folders (e.g. `\Noselect` hierarchy nodes) skipped
  with a log line rather than failing the rest.

Both use `EXAMINE` + `BODY.PEEK[]`: exporting a backup must not mark
anything as read (same rule as `fetch_messages`). Messages stream from
the FETCH response straight to a `BufWriter`, so memory stays flat
regardless of folder size. Per-message EML export ("save as .eml" on a
single message) already existed in the reader pane via a Blob download
and is unchanged.

## Verification

Unit tests in `mailstore.rs` (default `cargo test` pass, no network)
cover: message splitting with CRLF normalization, mboxrd
stuffing/unstuffing both ways, the mid-paragraph `From ` line that must
*not* split a message, rejection of non-mbox files, the write-then-read
byte-exact round trip, LF/CRLF/no-trailing-newline normalization, and
filename sanitization. The IMAP APPEND/FETCH halves ride the same
GreenMail conventions as the rest of `imap.rs` (see `imap-core.md`).
