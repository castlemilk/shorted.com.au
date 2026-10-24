/**
 * Escape closes the chat sheet. A chart or sparkline that is showing a reading takes
 * that Escape instead, to clear the reading, so a keyboard user dismissing a tooltip
 * keeps the conversation open. The charts (chat-charts.tsx) set `data-reading-active`
 * on their group while they show a reading, and this checks for it.
 *
 * It lives apart from the charts on purpose. ChatSidebarFull is in the root layout,
 * and this module is part of that eager bundle, so it imports nothing heavy.
 */

/** True when the target of an Escape press is a chart or sparkline showing a reading. */
export function escapeClearsReading(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-reading-active="true"]') !== null
  );
}
