/**
 * Shared relative-time formatter for news surfaces.
 *
 * Granularity:
 * - under a minute:  "just now"
 * - under an hour:   "12m ago"
 * - under a day:     "5h ago"
 * - under a week:    "3d ago"
 * - otherwise:       en-AU short date, e.g. "9 Jul"
 *
 * Invalid dates format as "" so callers can render nothing.
 * `now` is injectable for tests; defaults to the current time.
 */
export function formatRelativeTime(
  date: Date,
  now: Date = new Date(),
): string {
  if (Number.isNaN(date.getTime())) return "";

  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
