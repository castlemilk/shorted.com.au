// NO "use client" — server-safe, so /price-drops and the council hub render the
// same notice straight into their ISR HTML.
import type { DropsFreshness } from "@/lib/housing/drops-freshness";
import { cn } from "@/lib/utils";

/**
 * The 72h stale notice every crawl-derived drops surface shows once
 * dropsFreshness() says its data is older than DROPS_STALE_AFTER_HOURS. The
 * stale rule and the wording live in one place so a crawl outage reads the same
 * everywhere: when the crawl died on 2026-09-15, pages kept a frozen "last 30
 * days" window with nothing saying so.
 *
 * Renders nothing when the data is fresh or undated.
 */
export function DropsStaleNotice({
  freshness,
  scope,
  testId,
  className,
}: {
  freshness: DropsFreshness;
  /** Where the counts sit, e.g. "on this page" or "in this section". */
  scope: string;
  testId?: string;
  className?: string;
}) {
  if (!freshness.stale || !freshness.dataToLabel) return null;
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        "max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200",
        className,
      )}
    >
      These figures have not been updated for more than three days. Every
      &ldquo;last 30 days&rdquo; count {scope} runs to{" "}
      {freshness.dataToLabel.replace(/^Data to /, "")}, not to today, while
      the listing crawl is interrupted.
    </div>
  );
}
