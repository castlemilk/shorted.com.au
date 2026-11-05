import { useState } from "react";

import { Button } from "~/@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/@/components/ui/popover";
import { formatDate } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";
import type { StrategyDataStatusView } from "~/@/lib/strategies/types";

/**
 * "View source dates": the sessions the picks are read from and the ASIC
 * short-position reports behind them, with the day each became public. The
 * status is read when the popover first opens (the caller's `load`), and held
 * for the rest of the mount, so a closed and reopened popover asks nothing new.
 *
 * The figures are the API's; nothing is derived here beyond the date format.
 * A failed read says so in words and offers a retry.
 */
export interface SourceDatesPopoverProps {
  /** Reads GetStrategyDataStatus; null when the read failed. */
  load: () => Promise<StrategyDataStatusView | null>;
  className?: string;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; status: StrategyDataStatusView }
  | { phase: "failed" };

export function SourceDatesPopover({ load, className }: SourceDatesPopoverProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "idle" });

  async function fetchStatus() {
    setState({ phase: "loading" });
    try {
      const status = await load();
      setState(status ? { phase: "ready", status } : { phase: "failed" });
    } catch {
      setState({ phase: "failed" });
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && (state.phase === "idle" || state.phase === "failed")) {
      void fetchStatus();
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="sm"
          className={cn("h-auto p-0 text-xs text-primary", className)}
          aria-expanded={open}
        >
          View source dates
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,28rem)] p-4 text-sm">
        <h3 className="text-sm font-semibold">Source dates</h3>
        <SourceDatesBody state={state} onRetry={fetchStatus} />
      </PopoverContent>
    </Popover>
  );
}

function SourceDatesBody({
  state,
  onRetry,
}: {
  state: LoadState;
  onRetry: () => void;
}) {
  if (state.phase === "idle" || state.phase === "loading") {
    return (
      <p role="status" aria-busy="true" className="mt-2 text-muted-foreground">
        Loading the source dates…
      </p>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p>The source dates are unavailable right now.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  const { status } = state;
  const reports = status.asicReports.slice(0, 10);
  return (
    <div className="mt-2 space-y-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Latest prices</dt>
        <dd className="tabular-nums">
          {formatDate(status.latestSession) || "n/a"}
          {status.pricesCompletedAt
            ? ` · completed ${formatDate(status.pricesCompletedAt)}`
            : ""}
        </dd>
        <dt className="text-muted-foreground">Daily snapshot</dt>
        <dd className="tabular-nums">
          {formatDate(status.snapshotAsOf) || "n/a"}
          {status.snapshotCompletedAt
            ? ` · completed ${formatDate(status.snapshotCompletedAt)}`
            : ""}
        </dd>
        {status.pricedCodes > 0 ? (
          <>
            <dt className="text-muted-foreground">Stocks priced</dt>
            <dd className="tabular-nums">{status.pricedCodes.toLocaleString("en-AU")}</dd>
          </>
        ) : null}
      </dl>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          ASIC short positions
        </h4>
        {reports.length === 0 ? (
          <p className="mt-1 text-muted-foreground">No reports recorded yet.</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-xs">
            <caption className="sr-only">
              The newest ASIC short-position reports, with the day each became public
            </caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">Report</th>
                <th scope="col" className="py-1 pr-2 font-medium">Public</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">Rows</th>
                <th scope="col" className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.reportDate} className="border-b border-border/40">
                  <th scope="row" className="py-1 pr-2 text-left font-normal tabular-nums">
                    {formatDate(report.reportDate) || report.reportDate}
                  </th>
                  <td className="py-1 pr-2 tabular-nums">
                    {formatDate(report.availableDate) || "n/a"}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {report.rows.toLocaleString("en-AU")}
                  </td>
                  <td className="py-1">
                    {report.complete ? "Complete" : "Partial"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
