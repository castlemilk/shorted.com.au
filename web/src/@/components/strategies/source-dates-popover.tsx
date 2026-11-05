import { useEffect, useId, useRef, useState } from "react";

import { cn } from "~/@/lib/utils";
import { formatIsoDate } from "~/@/lib/strategies/format";
import type { StrategyDataStatusView } from "~/@/lib/strategies/types";

/**
 * "View source dates": the sessions the picks are read from and the ASIC
 * short-position reports behind them. The status is read when the panel first
 * opens (the caller's `load`) and held for the rest of the mount, so a closed
 * and reopened panel asks nothing new.
 *
 * The panel is a disclosure, not a floating popover: a Radix popover would add
 * its positioning and focus code to the Signals route's first load, and the
 * route is held to a budget. It sits under the provenance line it is placed in
 * (that line is the positioned ancestor, so the panel spans the line's width and
 * never runs past the viewport). It closes on Escape, on a press outside it and
 * when focus moves to a control outside it; Escape returns focus to the trigger.
 * The figures are the API's. "Available" is derived by the API (four sessions
 * after the report date) and is labelled so; "First recorded" is when we first
 * saw each report.
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

export function SourceDatesPopover({
  load,
  className,
}: SourceDatesPopoverProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  async function fetchStatus() {
    setState({ phase: "loading" });
    try {
      const status = await load();
      setState(status ? { phase: "ready", status } : { phase: "failed" });
    } catch {
      setState({ phase: "failed" });
    }
  }

  function onRetry() {
    // The Try again button leaves the DOM as the read starts; keep focus in the panel.
    panelRef.current?.focus();
    void fetchStatus();
  }

  function onToggle() {
    const next = !open;
    setOpen(next);
    if (next && (state.phase === "idle" || state.phase === "failed")) {
      void fetchStatus();
    }
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={cn(className)}
      onBlur={(event) => {
        // Focus moving to a control outside the panel closes it, so the panel
        // never sits over the controls a keyboard user reaches next.
        const next = event.relatedTarget as Node | null;
        if (open && next && !wrapRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="text-xs font-medium text-primary underline-offset-4 hover:underline"
      >
        View source dates
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll region needs focus for arrow-key scrolling.
          tabIndex={0}
          role="region"
          aria-label="Source dates"
          className="absolute left-0 right-0 top-full z-20 mt-2 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-card p-4 text-sm shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:left-auto sm:w-[28rem]"
        >
          <h3 className="text-sm font-semibold">Source dates</h3>
          <SourceDatesBody state={state} onRetry={onRetry} />
        </div>
      ) : null}
    </div>
  );
}

/** The next refresh in the viewer's own time zone, computed in the browser. */
function formatNextUpdate(value: string): string {
  const time = Date.parse(value);
  if (!value || Number.isNaN(time)) return "";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(time));
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
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/50"
        >
          Try again
        </button>
      </div>
    );
  }
  const { status } = state;
  const reports = status.asicReports.slice(0, 10);
  const nextUpdate = formatNextUpdate(status.nextUpdateUtc);
  return (
    <div className="mt-2 space-y-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Latest prices</dt>
        <dd className="tabular-nums">
          {formatIsoDate(status.latestSession) || "n/a"}
          {status.pricesCompletedAt
            ? ` · completed ${formatIsoDate(status.pricesCompletedAt)}`
            : ""}
        </dd>
        <dt className="text-muted-foreground">Daily snapshot</dt>
        <dd className="tabular-nums">
          {formatIsoDate(status.snapshotAsOf) || "n/a"}
          {status.snapshotCompletedAt
            ? ` · completed ${formatIsoDate(status.snapshotCompletedAt)}`
            : ""}
        </dd>
        {status.pricedCodes > 0 ? (
          <>
            <dt className="text-muted-foreground">Stocks priced</dt>
            <dd className="tabular-nums">
              {status.pricedCodes.toLocaleString("en-AU")}
            </dd>
          </>
        ) : null}
        {nextUpdate ? (
          <>
            <dt className="text-muted-foreground">Next update</dt>
            <dd className="tabular-nums">{nextUpdate}</dd>
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
          <>
            <table className="mt-2 w-full border-collapse text-xs">
              <caption className="sr-only">
                The newest ASIC short-position reports, with their derived
                availability and the day each was first recorded
              </caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Report
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Available (T+4)
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    First recorded
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    Rows
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr
                    key={report.reportDate}
                    className="border-b border-border/40"
                  >
                    <th
                      scope="row"
                      className="py-1 pr-2 text-left font-normal tabular-nums"
                    >
                      {formatIsoDate(report.reportDate) || report.reportDate}
                    </th>
                    <td className="py-1 pr-2 tabular-nums">
                      {formatIsoDate(report.availableDate) || "n/a"}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {formatIsoDate(report.firstIngestedAt) || "n/a"}
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
            <p className="mt-2 text-xs text-muted-foreground">
              Available is derived: four ASX sessions after the report date, not
              a publication time. First recorded is the day we first saw the
              report.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
