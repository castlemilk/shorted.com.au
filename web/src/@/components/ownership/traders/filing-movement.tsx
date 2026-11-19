import { investorPct } from "~/@/lib/ownership/australian-investors";
import { pointChange } from "~/@/lib/ownership/investor-activity";
import { noticeEventLabel } from "~/@/lib/ownership/events";
import type { DisclosureRow } from "~/@/lib/ownership/investor-disclosures";

const points = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
  signDisplay: "exceptZero",
});

export function MovementLabel({ row }: { row: DisclosureRow }) {
  const change = pointChange(row);
  if (change === null)
    return (
      <span className="text-xs text-muted-foreground">
        {noticeEventLabel(row.ceased ? "ceased" : row.event)}
      </span>
    );
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={`${investorPct(row.previous!)} to ${investorPct(row.pct!)}`}
    >
      {points.format(change).replace("-", "−")} pp
    </span>
  );
}

/** Endpoints are observations in one filing. Cessations have no present value. */
export function VotingRange({ row }: { row: DisclosureRow }) {
  const before = row.form === "603" ? null : row.previous;
  const after = row.ceased ? null : row.pct;
  if (before === null && after === null) return null;
  return (
    <span
      aria-hidden="true"
      className="relative my-2 block h-px w-full max-w-48 bg-border"
    >
      {before !== null && after !== null && (
        <span
          className="absolute -top-px h-[3px] bg-primary/70"
          style={{
            left: `${Math.min(before, after)}%`,
            width: `${Math.abs(after - before)}%`,
          }}
        />
      )}
      {before !== null && (
        <span
          className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground bg-background"
          style={{ left: `${before}%` }}
        />
      )}
      {after !== null && (
        <span
          className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
          style={{ left: `${after}%` }}
        />
      )}
    </span>
  );
}
