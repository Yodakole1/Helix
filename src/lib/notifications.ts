import { invoke, isTauri } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { isPermissionGranted } from "@tauri-apps/plugin-notification";

// Delivery goes through our own send_desktop_notification command
// (src-tauri/src/notifications.rs), NOT the notification plugin's
// sendNotification: the plugin's Linux path opens a fresh DBus connection
// per notification and drops it immediately, which makes GNOME Shell
// destroy the notification milliseconds after it's shown -- banners never
// appeared at all. The Rust command holds one connection for the app's
// lifetime instead. The plugin is still used for the permission
// check/request UI in Settings; only delivery is replaced.
function deliver(title: string, body: string, icon?: string): Promise<void> {
  return invoke("send_desktop_notification", { title, body, icon: icon ?? null });
}

// General-purpose variant for call sites outside this module (calendar
// reminders in App.tsx): resolves the app icon itself, then delivers
// through the same command as everything else.
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  const icon = await getNotificationIconPath();
  await deliver(title, body, icon);
}

// Resolved once per session and cached -- resolveResource is a round trip to
// the backend and the app's icon never changes at runtime. Requires
// "icons/128x128.png" to be listed under bundle.resources in
// tauri.conf.json (tauri-build copies it into target/debug or
// target/release, where resource_dir() points, on every build -- not just
// tauri build). Falls back to undefined (sending no icon) if the resource
// can't be resolved for any reason.
let iconPathPromise: Promise<string | undefined> | null = null;

export function getNotificationIconPath(): Promise<string | undefined> {
  if (!isTauri()) return Promise.resolve(undefined);
  if (!iconPathPromise) {
    iconPathPromise = resolveResource("icons/128x128.png").catch(() => undefined);
  }
  return iconPathPromise;
}

export interface NewMailNotificationMessage {
  sender: string;
  senderEmail: string;
  subject: string;
}

// Fires a "new mail" desktop notification, gated on the "Notify on new mail"
// Settings toggle and the OS permission, both read/checked at call time so a
// toggle in Settings applies without a restart. Built from the actual
// newly-arrived message(s) -- the address it's from, then the subject --
// rather than a bare count, and carries the app's own icon rather than
// whatever the notification daemon guesses (which finds nothing outside an
// installed .desktop entry, i.e. every dev build).
export async function notifyNewMail(messages: NewMailNotificationMessage[]): Promise<void> {
  if (messages.length === 0) return;
  if (localStorage.getItem("helix:notifyNewMail") !== "1") return;
  const granted = await isPermissionGranted().catch(() => false);
  if (!granted) return;

  const icon = await getNotificationIconPath();
  const [first] = messages;

  if (messages.length === 1) {
    await deliver(first.senderEmail || first.sender || "New mail", first.subject || "(no subject)", icon);
    return;
  }

  const lines = messages
    .slice(0, 3)
    .map((m) => `${m.senderEmail || m.sender}: ${m.subject || "(no subject)"}`);
  if (messages.length > 3) lines.push(`+${messages.length - 3} more`);
  await deliver(`${messages.length} new messages`, lines.join("\n"), icon);
}

// The Settings -> Notifications "Send test notification" button (visible in
// Debug mode). The timestamp keeps the body distinct on every click -- some
// notification daemons (GNOME Shell among them) collapse an identical
// summary+body sent again in quick succession into the existing banner
// instead of popping a new one, which otherwise reads as "it only works
// once". Rejects with the backend's error message so the button can show
// what actually went wrong instead of silently doing nothing.
export async function sendTestNotification(): Promise<void> {
  const icon = await getNotificationIconPath();
  await deliver("Helix", `This is a test notification (${new Date().toLocaleTimeString()}).`, icon);
}
