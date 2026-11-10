import { OUTCOME_COPY, WITHHOLDING_OUTCOMES } from "~/@/lib/ownership/kinds";

// Server-safe: no "use client", no Connect import.
//
// The withholding outcomes, each with its count. Two documents are not
// withheld at all (a document that is not a holding form, and one not yet
// downloaded), so they are named apart in a sentence and never listed as
// withheld notices.

const NOT_A_NOTICE = "not_a_notice";
const NOT_DOWNLOADED = "fetch_error";
// ASX's own "cannot display PDF": the notice is not on ASX's site any more, so it is set aside.
const NOT_AVAILABLE = "unavailable";

export interface WithheldCount {
  outcome: string;
  count: number;
}

/**
 * The two documents that are not withheld, named apart. A half with no count is
 * not said at all: a zero is not a document, so it is not a clause.
 */
function apartLine(forms: number, pending: number, unavailable: number): string | null {
  const parts: { text: string; count: number }[] = [];
  if (forms > 0) {
    parts.push({
      text:
        forms === 1
          ? "1 document was not a substantial holding form"
          : `${forms.toLocaleString("en-AU")} documents were not substantial holding forms`,
      count: forms,
    });
  }
  if (pending > 0) {
    parts.push({
      text:
        pending === 1
          ? "1 has not yet been downloaded"
          : `${pending.toLocaleString("en-AU")} have not yet been downloaded`,
      count: pending,
    });
  }
  if (unavailable > 0) {
    parts.push({
      text:
        unavailable === 1
          ? "1 is not available from ASX"
          : `${unavailable.toLocaleString("en-AU")} are not available from ASX`,
      count: unavailable,
    });
  }
  const [first, second, third] = parts;
  if (!first) return null;
  if (!second) {
    return `A further ${first.text}; ${first.count === 1 ? "it is not a withheld notice." : "they are not withheld notices."}`;
  }
  if (!third) {
    return `A further ${first.text} and ${second.text}; neither is a withheld notice.`;
  }
  return `A further ${first.text}, ${second.text} and ${third.text}; none is a withheld notice.`;
}

export function WithheldBreakdown({ outcomes }: { outcomes: readonly WithheldCount[] }) {
  const counts = new Map<string, number>();
  for (const { outcome, count } of outcomes) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + count);
  }
  const apart = new Set([NOT_A_NOTICE, NOT_DOWNLOADED, NOT_AVAILABLE]);
  // Every withholding outcome is listed, a zero included: the breakdown answers
  // "how many of each", and an absent outcome is a count of none.
  const rows = [
    ...WITHHOLDING_OUTCOMES.map((outcome) => ({ outcome, count: counts.get(outcome) ?? 0 })),
    // An outcome this page has no copy for prints its raw name, not a guess.
    ...Array.from(counts)
      .filter(([outcome]) => !WITHHOLDING_OUTCOMES.includes(outcome) && !apart.has(outcome))
      .map(([outcome, count]) => ({ outcome, count })),
  ];
  const line = apartLine(
    counts.get(NOT_A_NOTICE) ?? 0,
    counts.get(NOT_DOWNLOADED) ?? 0,
    counts.get(NOT_AVAILABLE) ?? 0,
  );

  return (
    <div className="space-y-2 text-xs">
      <dl className="space-y-1">
        {rows.map(({ outcome, count }) => (
          <div key={outcome} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{OUTCOME_COPY[outcome] ?? outcome}</dt>
            <dd className="tabular-nums text-foreground">{count.toLocaleString("en-AU")}</dd>
          </div>
        ))}
      </dl>
      {line ? <p className="tabular-nums text-muted-foreground">{line}</p> : null}
    </div>
  );
}
