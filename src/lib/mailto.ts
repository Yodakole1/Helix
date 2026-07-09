import { invoke, isTauri } from "@tauri-apps/api/core";

// Thin wrappers around src-tauri/src/mailto.rs plus the mailto: URL parser
// used when Helix is launched as the system mail handler.

export function isDefaultMailClient(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke("is_default_mail_client");
}

export function setDefaultMailClient(): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error("Only available in the desktop app"));
  return invoke("set_default_mail_client");
}

export function getLaunchMailto(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke("get_launch_mailto");
}

export interface MailtoFields {
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

// RFC 6068 mailto parsing, the pragmatic subset real links use:
// mailto:addr1,addr2?subject=...&cc=...&bcc=...&body=... with
// percent-encoding throughout. Returns null for anything unparseable.
export function parseMailto(url: string): MailtoFields | null {
  if (!url.toLowerCase().startsWith("mailto:")) return null;
  const rest = url.slice("mailto:".length);
  const [addrPart, queryPart] = rest.split("?", 2);
  const fields: MailtoFields = {
    to: decodeURIComponent(addrPart ?? ""),
    cc: [],
    bcc: [],
    subject: "",
    body: "",
  };
  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const [rawKey, rawValue = ""] = pair.split("=", 2);
      const value = decodeURIComponent(rawValue.replace(/\+/g, "%20"));
      switch (rawKey.toLowerCase()) {
        case "to":
          fields.to = fields.to ? `${fields.to},${value}` : value;
          break;
        case "cc":
          fields.cc = value.split(",").map((a) => a.trim()).filter(Boolean);
          break;
        case "bcc":
          fields.bcc = value.split(",").map((a) => a.trim()).filter(Boolean);
          break;
        case "subject":
          fields.subject = value;
          break;
        case "body":
          fields.body = value;
          break;
      }
    }
  }
  return fields;
}
