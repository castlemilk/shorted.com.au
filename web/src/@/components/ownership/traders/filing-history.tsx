import type { DisclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { investorPct } from "~/@/lib/ownership/australian-investors";

export function FilingHistory({ rows }: { rows: DisclosureRow[] }) {
  return (
    <ul className="divide-y border-y">
      {rows.map((r) => (
        <li
          key={`${r.code}/${r.name}/${r.date}/${r.source}`}
          className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 py-3 text-sm"
        >
          <div>
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
          <span className="tabular-nums">
            {r.previous !== null && <>{investorPct(r.previous)} → </>}
            {r.ceased
              ? "Ceased to be substantial"
              : r.pct === null
                ? "Voting power unstated"
                : investorPct(r.pct)}
          </span>
        </li>
      ))}
    </ul>
  );
}
