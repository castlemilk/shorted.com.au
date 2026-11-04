import { cn } from "~/@/lib/utils";
import { reasonText } from "~/@/lib/strategies/evidence";
import type { RuleResultRow } from "~/@/lib/strategies/types";

/**
 * One rule's outcome on the Signals matrix, as a mark and a word. The mark
 * never uses the market colours (DESIGN.md's Semantic Quarantine Rule): a pass
 * is a filled amber dot, a fail a hollow ring, an unknown a dashed ring, and a
 * waiting trigger a hollow amber ring. The word is the carrier of meaning; the
 * mark is decoration, so it is aria-hidden.
 */
export type RuleState = "pass" | "fail" | "unknown" | "waiting";

/** A rule result as the state the matrix draws. No result reads unknown. */
export function ruleState(result: RuleResultRow | undefined): RuleState {
  if (!result) return "unknown";
  if (result.status === "pass") return "pass";
  if (result.status === "fail")
    return result.waiting === true ? "waiting" : "fail";
  return "unknown";
}

const WORD: Record<RuleState, string> = {
  pass: "Pass",
  fail: "Fail",
  unknown: "Unknown",
  waiting: "Waiting",
};

export function ruleStateWord(state: RuleState): string {
  return WORD[state];
}

/** The round mark for one state. */
export function RuleStateMark({ state }: { state: RuleState }) {
  return (
    <span
      aria-hidden="true"
      data-rule-state={state}
      className={cn(
        "block h-2.5 w-2.5 shrink-0 rounded-full border",
        state === "pass" && "border-primary bg-primary",
        state === "fail" && "border-muted-foreground bg-transparent",
        state === "waiting" && "border-primary bg-transparent",
        state === "unknown" &&
          "border-dashed border-muted-foreground bg-transparent",
      )}
    />
  );
}

/**
 * A matrix cell: the mark, the word, and for an unknown rule the reason it
 * could not be tested. The screen-reader text names the rule, its outcome and
 * its measure ("Short crowding: pass, 10.0% ≥ 5%").
 */
export function RuleCell({
  title,
  result,
  measure,
}: {
  title: string;
  result: RuleResultRow | undefined;
  /** The measured value against the threshold, when the API sent both. */
  measure?: string | null;
}) {
  const state = ruleState(result);
  const word = WORD[state];
  const reason = state === "unknown" ? reasonText(result?.reason) : "";
  const detail = [measure, reason].filter(Boolean).join(", ");
  return (
    <td className="px-3 py-2 align-top">
      <div className="flex items-start gap-1.5 whitespace-nowrap">
        <span className="mt-[3px]">
          <RuleStateMark state={state} />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-medium">{word}</span>
          {reason ? (
            <span className="max-w-[12rem] whitespace-normal text-[11px] leading-tight text-muted-foreground">
              {reason}
            </span>
          ) : null}
        </span>
      </div>
      <span className="sr-only">
        {`${title}: ${word.toLowerCase()}${detail ? `, ${detail}` : ""}`}
      </span>
    </td>
  );
}
