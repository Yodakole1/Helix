import { invoke } from "@tauri-apps/api/core";

// Thin wrappers around src-tauri/src/ics.rs. Field names stay snake_case to
// match serde's default Serialize output on the Rust side.

export interface InviteInfo {
  summary: string | null;
  organizer: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  uid: string | null;
  method: string | null;
}

// Parses a base64-encoded text/calendar MIME part into structured fields.
// Best-effort: missing or unrecognised fields come back as null, not errors.
export function parseIcsInvite(dataBase64: string): Promise<InviteInfo> {
  return invoke("parse_ics_invite", { dataBase64 });
}

// Sends a VCALENDAR METHOD:REPLY to the organizer via the account's SMTP.
// `response` must be "accept", "decline", or "tentative".
export function respondToInvite(args: {
  accountId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUseStarttls: boolean;
  organizerEmail: string;
  inviteUid: string;
  summary: string | null;
  dtstart: string | null;
  dtend: string | null;
  response: "accept" | "decline" | "tentative";
}): Promise<void> {
  return invoke("respond_to_invite", {
    accountId: args.accountId,
    smtpHost: args.smtpHost,
    smtpPort: args.smtpPort,
    smtpUseStarttls: args.smtpUseStarttls,
    organizerEmail: args.organizerEmail,
    inviteUid: args.inviteUid,
    summary: args.summary,
    dtstart: args.dtstart,
    dtend: args.dtend,
    response: args.response,
  });
}
