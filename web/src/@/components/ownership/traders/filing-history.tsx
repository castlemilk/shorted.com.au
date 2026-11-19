import type { DisclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { investorPct } from "~/@/lib/ownership/australian-investors";
import { filingId } from "~/@/lib/ownership/investor-activity";
import { MovementLabel, VotingRange } from "./filing-movement";

export function FilingHistory({ rows }: { rows: DisclosureRow[] }) {
  return (
    <div className="space-y-3">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(7rem,auto)] gap-x-4 border-t bg-muted/40 py-2 text-xs text-muted-foreground sm:grid"
      >
        <span>Release / source</span>
        <span>Previous → reported voting power</span>
        <span className="text-right">Change</span>
      </div>
      <ul className="!mt-0 divide-y border-y">
        {rows.map((r) => (
          <li
            key={filingId(r)}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(7rem,auto)]"
          >
            <div className="col-span-2 sm:col-span-1">
              <time dateTime={r.date}>{r.date}</time> · {r.code} ·{" "}
              {r.source ? (
                <a href={r.source} className="text-primary hover:underline">
                  Form {r.form}
                </a>
              ) : (
                `Form ${r.form}`
              )}
              {r.effective && r.effective !== r.date && (
                <p className="text-xs text-muted-foreground">
                  Effective {r.effective}
                </p>
              )}
            </div>
            <div className="min-w-0">
              <span className="tabular-nums">
                {r.previous !== null && r.form !== "603" && (
                  <>{investorPct(r.previous)} → </>
                )}
                {r.ceased
                  ? "Ceased to be substantial"
                  : r.pct === null
                    ? "Voting power unstated"
                    : investorPct(r.pct)}
              </span>
              <VotingRange row={r} />
            </div>
            <span className="text-right">
              <MovementLabel row={r} />
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Open dots mark previous voting power and solid dots mark reported voting
        power on a 0–100% scale. Changes are in percentage points (pp).
      </p>
    </div>
  );
}
