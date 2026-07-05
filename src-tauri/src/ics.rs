use base64::Engine;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Serialize;

use crate::credentials;

/// Fields extracted from a `text/calendar` MIME part. Missing fields come
/// back as `None` — real-world ICS files vary a lot. `method` is from
/// the outer VCALENDAR; everything else is from the first VEVENT.
#[derive(Debug, Serialize)]
pub struct InviteInfo {
    pub summary: Option<String>,
    /// Organizer's email with `mailto:` prefix stripped.
    pub organizer: Option<String>,
    /// Raw DTSTART value (e.g. `"20260701T100000Z"` or `"20260701"`).
    pub start: Option<String>,
    pub end: Option<String>,
    pub location: Option<String>,
    pub uid: Option<String>,
    pub method: Option<String>,
}

// RFC 5545 line folding: CRLF + single whitespace = continuation, strip it.
fn unfold_ics(input: &str) -> String {
    input
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "")
}

fn parse_ics_text(ics: &str) -> InviteInfo {
    let unfolded = unfold_ics(ics);
    let mut info = InviteInfo {
        summary: None,
        organizer: None,
        start: None,
        end: None,
        location: None,
        uid: None,
        method: None,
    };
    let mut in_vevent = false;

    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');

        if line == "BEGIN:VEVENT" {
            in_vevent = true;
            continue;
        }
        if line == "END:VEVENT" {
            in_vevent = false;
            continue;
        }

        let Some((key_with_params, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        // Strip property parameters — "DTSTART;TZID=America/New_York" → "DTSTART".
        let key = key_with_params
            .split(';')
            .next()
            .unwrap_or(key_with_params)
            .to_uppercase();

        match key.as_str() {
            "METHOD" if !in_vevent => info.method = Some(value.to_string()),
            "SUMMARY" if in_vevent => info.summary = Some(value.to_string()),
            "DTSTART" if in_vevent => info.start = Some(value.to_string()),
            "DTEND" if in_vevent => info.end = Some(value.to_string()),
            "LOCATION" if in_vevent => info.location = Some(value.to_string()),
            "UID" if in_vevent => info.uid = Some(value.to_string()),
            "ORGANIZER" if in_vevent => {
                // Strip mailto: for display; the send path adds it back.
                info.organizer = Some(value.trim_start_matches("mailto:").to_string());
            }
            _ => {}
        }
    }

    info
}

/// Parses a base64-encoded `text/calendar` part into structured fields for
/// rendering a meeting-invite card. Best-effort — missing fields come back as
/// `None`, not errors.
#[tauri::command]
pub fn parse_ics_invite(data_base64: String) -> Result<InviteInfo, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("invalid base64 ICS data: {e}"))?;
    Ok(parse_ics_text(&String::from_utf8_lossy(&bytes)))
}

fn partstat_str(response: &str) -> Result<&'static str, String> {
    match response.to_lowercase().as_str() {
        "accept" => Ok("ACCEPTED"),
        "decline" => Ok("DECLINED"),
        "tentative" => Ok("TENTATIVE"),
        other => Err(format!(
            "unknown response {other:?}: expected \"accept\", \"decline\", or \"tentative\""
        )),
    }
}

fn build_vcalendar_reply(
    organizer_email: &str,
    attendee_email: &str,
    invite_uid: &str,
    summary: Option<&str>,
    dtstart: Option<&str>,
    dtend: Option<&str>,
    partstat: &str,
) -> String {
    let mut cal = String::new();
    cal.push_str("BEGIN:VCALENDAR\r\n");
    cal.push_str("VERSION:2.0\r\n");
    cal.push_str("PRODID:-//Helix Mail//EN\r\n");
    cal.push_str("METHOD:REPLY\r\n");
    cal.push_str("BEGIN:VEVENT\r\n");
    cal.push_str(&format!("UID:{invite_uid}\r\n"));
    if let Some(s) = summary {
        cal.push_str(&format!("SUMMARY:{s}\r\n"));
    }
    if let Some(s) = dtstart {
        cal.push_str(&format!("DTSTART:{s}\r\n"));
    }
    if let Some(e) = dtend {
        cal.push_str(&format!("DTEND:{e}\r\n"));
    }
    cal.push_str(&format!("ORGANIZER:mailto:{organizer_email}\r\n"));
    cal.push_str(&format!(
        "ATTENDEE;PARTSTAT={partstat}:mailto:{attendee_email}\r\n"
    ));
    cal.push_str("END:VEVENT\r\n");
    cal.push_str("END:VCALENDAR\r\n");
    cal
}

/// Sends a VCALENDAR REPLY to the meeting organizer.
/// `account_id` is both the SMTP auth credential and the attendee address.
/// `response` is one of `"accept"`, `"decline"`, or `"tentative"`.
#[tauri::command]
pub async fn respond_to_invite(
    account_id: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_use_starttls: bool,
    organizer_email: String,
    invite_uid: String,
    summary: Option<String>,
    dtstart: Option<String>,
    dtend: Option<String>,
    response: String,
) -> Result<(), String> {
    let partstat = partstat_str(&response)?;
    let password = credentials::get_credential(account_id.clone())?;

    let ics_body = build_vcalendar_reply(
        &organizer_email,
        &account_id,
        &invite_uid,
        summary.as_deref(),
        dtstart.as_deref(),
        dtend.as_deref(),
        partstat,
    );

    let subject = match partstat {
        "ACCEPTED" => format!("Accepted: {}", summary.as_deref().unwrap_or("Meeting invite")),
        "DECLINED" => format!("Declined: {}", summary.as_deref().unwrap_or("Meeting invite")),
        _ => format!(
            "Tentatively accepted: {}",
            summary.as_deref().unwrap_or("Meeting invite")
        ),
    };

    let calendar_ct =
        ContentType::parse("text/calendar; charset=\"UTF-8\"; method=\"REPLY\"")
            .map_err(|e| format!("could not build calendar content-type: {e}"))?;

    let from: lettre::message::Mailbox = account_id
        .parse()
        .map_err(|e| format!("invalid from address {account_id:?}: {e}"))?;
    let to: lettre::message::Mailbox = organizer_email
        .parse()
        .map_err(|e| format!("invalid organizer address {organizer_email:?}: {e}"))?;

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .header(calendar_ct)
        .body(ics_body)
        .map_err(|e| format!("could not build reply message: {e}"))?;

    let builder = if smtp_use_starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp_host)
    }
    .map_err(|e| format!("could not configure SMTP relay for {smtp_host}: {e}"))?;

    let mailer: AsyncSmtpTransport<Tokio1Executor> = builder
        .port(smtp_port)
        .credentials(Credentials::new(account_id, password))
        .build();

    mailer
        .send(email)
        .await
        .map(|_| ())
        .map_err(|e| format!("send failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ics_text_extracts_all_standard_fields() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   METHOD:REQUEST\r\n\
                   BEGIN:VEVENT\r\n\
                   SUMMARY:Team standup\r\n\
                   DTSTART:20260701T100000Z\r\n\
                   DTEND:20260701T103000Z\r\n\
                   LOCATION:Conf room A\r\n\
                   UID:abc-123@cal.example.com\r\n\
                   ORGANIZER:mailto:boss@example.com\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        assert_eq!(info.method.as_deref(), Some("REQUEST"));
        assert_eq!(info.summary.as_deref(), Some("Team standup"));
        assert_eq!(info.start.as_deref(), Some("20260701T100000Z"));
        assert_eq!(info.end.as_deref(), Some("20260701T103000Z"));
        assert_eq!(info.location.as_deref(), Some("Conf room A"));
        assert_eq!(info.uid.as_deref(), Some("abc-123@cal.example.com"));
        assert_eq!(info.organizer.as_deref(), Some("boss@example.com"));
    }

    #[test]
    fn parse_ics_text_handles_organizer_with_cn_param() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   ORGANIZER;CN=Boss Name:mailto:boss@example.com\r\n\
                   UID:uid1\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        assert_eq!(info.organizer.as_deref(), Some("boss@example.com"));
    }

    #[test]
    fn parse_ics_text_handles_dtstart_with_tzid_param() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   DTSTART;TZID=America/New_York:20260701T100000\r\n\
                   UID:uid2\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        // TZID is on the key side; value after the first ':' is just the timestamp.
        assert_eq!(info.start.as_deref(), Some("20260701T100000"));
    }

    #[test]
    fn parse_ics_text_unfolds_long_lines() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   SUMMARY:A very long su\r\n bject that is folded\r\n\
                   UID:fold-test\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        assert_eq!(info.summary.as_deref(), Some("A very long subject that is folded"));
        assert_eq!(info.uid.as_deref(), Some("fold-test"));
    }

    #[test]
    fn parse_ics_text_ignores_summary_outside_vevent() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   METHOD:REQUEST\r\n\
                   SUMMARY:top-level junk\r\n\
                   BEGIN:VEVENT\r\n\
                   SUMMARY:real summary\r\n\
                   UID:uid1\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        assert_eq!(info.summary.as_deref(), Some("real summary"));
    }

    #[test]
    fn parse_ics_text_returns_none_for_missing_fields() {
        let ics = "BEGIN:VCALENDAR\r\n\
                   BEGIN:VEVENT\r\n\
                   UID:uid-only\r\n\
                   END:VEVENT\r\n\
                   END:VCALENDAR\r\n";
        let info = parse_ics_text(ics);
        assert_eq!(info.uid.as_deref(), Some("uid-only"));
        assert!(info.summary.is_none());
        assert!(info.start.is_none());
        assert!(info.organizer.is_none());
    }

    #[test]
    fn partstat_str_maps_all_three_responses() {
        assert_eq!(partstat_str("accept").unwrap(), "ACCEPTED");
        assert_eq!(partstat_str("ACCEPT").unwrap(), "ACCEPTED");
        assert_eq!(partstat_str("decline").unwrap(), "DECLINED");
        assert_eq!(partstat_str("DECLINE").unwrap(), "DECLINED");
        assert_eq!(partstat_str("tentative").unwrap(), "TENTATIVE");
        assert_eq!(partstat_str("TENTATIVE").unwrap(), "TENTATIVE");
        assert!(partstat_str("maybe").is_err());
    }

    #[test]
    fn build_vcalendar_reply_contains_all_required_parts() {
        let reply = build_vcalendar_reply(
            "boss@example.com",
            "me@example.com",
            "abc-123",
            Some("Team standup"),
            Some("20260701T100000Z"),
            Some("20260701T103000Z"),
            "ACCEPTED",
        );
        assert!(reply.contains("METHOD:REPLY\r\n"));
        assert!(reply.contains("UID:abc-123\r\n"));
        assert!(reply.contains("SUMMARY:Team standup\r\n"));
        assert!(reply.contains("DTSTART:20260701T100000Z\r\n"));
        assert!(reply.contains("DTEND:20260701T103000Z\r\n"));
        assert!(reply.contains("ORGANIZER:mailto:boss@example.com\r\n"));
        assert!(reply.contains("ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r\n"));
    }

    #[test]
    fn build_vcalendar_reply_omits_optional_fields_when_absent() {
        let reply = build_vcalendar_reply(
            "boss@example.com",
            "me@example.com",
            "uid-only",
            None,
            None,
            None,
            "DECLINED",
        );
        assert!(reply.contains("ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com\r\n"));
        assert!(!reply.contains("SUMMARY:"));
        assert!(!reply.contains("DTSTART:"));
        assert!(!reply.contains("DTEND:"));
    }
}
