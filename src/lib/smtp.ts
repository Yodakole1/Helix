import { invoke } from "@tauri-apps/api/core";

export interface OutgoingAttachment {
  filename: string;
  content_type: string;
  // Standard base64 -- IPC payloads go through JSON where Vec<u8> would
  // serialize as an array of numbers, far larger than a base64 string.
  content_base64: string;
  // When set, this is an inline image referenced from the HTML body as
  // <img src="cid:<content_id>">. The backend wraps it in multipart/related.
  content_id?: string;
}

export interface SendMessageArgs {
  accountId: string;
  host: string;
  port: number;
  useStarttls: boolean;
  to: string;
  // Comma-separated address lists, same shape as `to`. Default to empty
  // strings (the backend treats an empty list as "no Cc/Bcc").
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string | null;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string | null;
  references?: string[];
  encrypt?: boolean;
}

export function sendMessage(args: SendMessageArgs): Promise<void> {
  return invoke("send_message", {
    accountId: args.accountId,
    host: args.host,
    port: args.port,
    useStarttls: args.useStarttls,
    to: args.to,
    cc: args.cc ?? "",
    bcc: args.bcc ?? "",
    subject: args.subject,
    body: args.body,
    html: args.html ?? null,
    attachments: args.attachments ?? [],
    inReplyTo: args.inReplyTo ?? null,
    references: args.references ?? [],
    encrypt: args.encrypt ?? false,
  });
}

// Reads a File from the browser's File API as a base64-encoded string,
// ready to hand to send_message's attachments array.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" -- strip the prefix.
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface SendMdnArgs {
  accountId: string;
  host: string;
  port: number;
  useStarttls: boolean;
  notifyAddress: string;
  originalMessageId: string;
  originalSubject: string;
  recipientDisplayAddress: string;
}

export function sendMdn(args: SendMdnArgs): Promise<void> {
  return invoke("send_mdn", {
    accountId: args.accountId,
    host: args.host,
    port: args.port,
    useStarttls: args.useStarttls,
    notifyAddress: args.notifyAddress,
    originalMessageId: args.originalMessageId,
    originalSubject: args.originalSubject,
    recipientDisplayAddress: args.recipientDisplayAddress,
  });
}
