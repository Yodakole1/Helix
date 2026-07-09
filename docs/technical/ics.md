# ICS invite handling

`src-tauri/src/ics.rs` — new module, no additional crate dependency. RFC 5545
calendar data is a simple line-based format; the subset Helix needs (extracting
a handful of VEVENT fields and building a VCALENDAR REPLY) doesn't justify
pulling in a full parser crate. The module is two Tauri commands and three
pure helpers.

## How an invite arrives

`fetch_message_body` returns calendar invites as entries in the `attachments`
list with `content_type = "text/calendar"`. The bytes are base64-encoded (same
as all attachments in the IPC layer). The frontend detects this content type
and passes the base64 data to `parse_ics_invite`.

## Commands

### `parse_ics_invite(data_base64) → InviteInfo`

Decodes the base64, applies RFC 5545 line unfolding (CRLF + single whitespace =
continuation of the previous line), then walks the lines looking for:

- `METHOD` at the VCALENDAR level (outside any `VEVENT`) → `method`
- `SUMMARY`, `DTSTART`, `DTEND`, `LOCATION`, `UID`, `ORGANIZER` inside the
  first `VEVENT` block

Property parameters (`DTSTART;TZID=...`, `ORGANIZER;CN=...`) are stripped from
the key before matching — only the base property name is used. The value is
everything after the first `:` on the line, so `DTSTART;TZID=America/New_York:
20260701T100000` yields `"20260701T100000"` for `start` (TZID is lost; see
limitations below). `ORGANIZER`'s `mailto:` prefix is stripped for display;
`respond_to_invite` adds it back when building the reply body.

All fields are `Option<String>` and come back as `None` if not found in the
VEVENT. Missing fields are not an error — real-world ICS files vary in what
they populate.

### `respond_to_invite(account_id, smtp_host, smtp_port, smtp_use_starttls, organizer_email, invite_uid, summary, dtstart, dtend, response) → ()`

Builds a `VCALENDAR METHOD:REPLY` body and sends it to `organizer_email` via
SMTP using the account's stored credential. `response` is one of `"accept"`,
`"decline"`, or `"tentative"` (case-insensitive); anything else is a hard
error before the network is touched.

The VCALENDAR body echoes back the invite's `UID` (required for the organizer's
system to match the reply to the original event), and optionally `SUMMARY`,
`DTSTART`, `DTEND` (so the reply is interpretable as a plain message in
clients that display calendar data). The `ATTENDEE` line carries the
`PARTSTAT` status (`ACCEPTED`, `DECLINED`, or `TENTATIVE`).

The message is sent with `Content-Type: text/calendar; charset=UTF-8;
method=REPLY` per RFC 5546. No plain-text fallback body is included — the
VCALENDAR text is the only body part, which is standard for programmatic
calendar replies (as opposed to human-readable meeting-response emails).

## SMTP reuse

`respond_to_invite` follows the exact same `starttls_relay()`/`relay()`
pattern as `smtp::send_message` — same credential lookup, same TLS flag
semantics. No separate `smtp_password` parameter: authentication is
resolved through `smtp::transport_credentials`, the shared helper
`send_message` uses, so an OAuth account gets a fresh access token with
XOAUTH2 pinned and a password account gets its keychain password. (It
originally did its own `get_credential` + PLAIN, which predated OAuth
and would have sent an OAuth account's token blob as a password — see
security.md's 2026-07-06 entry.)

## Limitations

- **TZID is lost in the reply.** `DTSTART;TZID=America/New_York:20260701T100000`
  is echoed back as `DTSTART:20260701T100000` (floating time). This is a
  known simplification: most calendar servers match replies solely on `UID`
  and don't use `DTSTART` from the reply, so this is acceptable in practice.
- **Only the first VEVENT is parsed.** Multi-event ICS files (recurring
  events with multiple `VEVENT` blocks representing exceptions) are handled
  by reading only the first block. Recurring-event support would require
  richer parsing.
- **No `CANCEL` / `COUNTER` / `REFRESH` method support.** `parse_ics_invite`
  surfaces the `method` field so the UI can render a "This event was
  cancelled" card, but `respond_to_invite` only sends `REPLY`-method
  responses; sending a `COUNTER` (propose new time) or handling a `CANCEL`
  is not implemented.

## Verification

All non-network logic is covered by unit tests in `ics::tests`:

- `parse_ics_text_extracts_all_standard_fields` — all six VEVENT fields in
  a well-formed ICS
- `parse_ics_text_handles_organizer_with_cn_param` — `ORGANIZER;CN=Name:mailto:…`
- `parse_ics_text_handles_dtstart_with_tzid_param` — `DTSTART;TZID=…:…`
- `parse_ics_text_unfolds_long_lines` — RFC 5545 CRLF continuation
- `parse_ics_text_ignores_summary_outside_vevent` — top-level properties
  outside VEVENT don't pollute VEVENT fields
- `parse_ics_text_returns_none_for_missing_fields` — absent fields are `None`
- `partstat_str_maps_all_three_responses` — accept/decline/tentative mapping
- `build_vcalendar_reply_contains_all_required_parts` — full reply body
- `build_vcalendar_reply_omits_optional_fields_when_absent` — `None` fields

`respond_to_invite`'s actual SMTP send is not tested here (no GreenMail test
written yet) — the SMTP mechanics are identical to `smtp::send_message`, which
has its own GreenMail coverage.
