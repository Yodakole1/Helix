// Clock-format preference. 24-hour is the default everywhere; Settings >
// General offers 12-hour (AM/PM) for those who want it. Read from
// localStorage at call time -- same pattern as the notification toggles --
// so applying the setting takes effect immediately, including in pure
// helpers (formatMessageTime and friends) that have no access to React
// state.
export function use12HourClock(): boolean {
  return localStorage.getItem("helix:hour12") === "true";
}

// The one way to render a wall-clock time in this app. Everything that
// shows a time to the user (message rows, reader header, calendar events,
// reminders, snooze presets, notifications) goes through here so the
// Settings choice actually covers the whole UI. Editable HH:MM inputs
// (calendar event start/end fields) deliberately don't -- they're parsed
// back and stay 24-hour.
export function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: use12HourClock() });
}
