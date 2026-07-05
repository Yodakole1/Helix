// Minimal in-app event bus connecting the sidebar's calendar section to
// CalendarView. When a calendar tab is open the sidebar lists the connected
// calendars and hosts the "Add calendar" action, but the add form and the
// source mutations live in CalendarView -- they share no parent below
// App.tsx, and App shouldn't own calendar state just to relay two signals.
//
// Events:
//  - "sources-changed": a calendar source was added or removed; anyone
//    showing the source list should reload it. Emitted by whichever side
//    performed the mutation (never by a reload handler, so no loops).
//  - "open-add-calendar": the sidebar's Add calendar button was pressed;
//    CalendarView opens its add form.

type CalendarBusEvent = "sources-changed" | "open-add-calendar";

const listeners: Record<CalendarBusEvent, Set<() => void>> = {
  "sources-changed": new Set(),
  "open-add-calendar": new Set(),
};

export function onCalendarBus(event: CalendarBusEvent, fn: () => void): () => void {
  listeners[event].add(fn);
  return () => {
    listeners[event].delete(fn);
  };
}

export function emitCalendarBus(event: CalendarBusEvent): void {
  for (const fn of [...listeners[event]]) fn();
}
