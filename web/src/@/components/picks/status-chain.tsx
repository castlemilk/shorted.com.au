import { RuleDot } from "./picks-table";
import type { PickStatus, RuleStatus } from "~/@/lib/strategies/types";

/**
 * What a status looks like as rule outcomes: three dots on a trace beside the
 * word, so the hub teaches "setup is every core rule but the trigger" before
 * a reader reaches a table. Triggered = pass pass pass; setup = pass pass
 * fail (the trigger); watch = pass fail unknown. Decorative: aria-hidden, the
 * word and its description carry the meaning.
 *
 * Props-only and server-safe; it imports RuleDot from the table kit and
 * nothing imports it from the sort island's graph.
 */
const CHAIN: Record<PickStatus, readonly RuleStatus[]> = {
  triggered: ["pass", "pass", "pass"],
  setup: ["pass", "pass", "fail"],
  watch: ["pass", "fail", "unknown"],
};

export function StatusChain({ status }: { status: PickStatus }) {
  return (
    <span
      aria-hidden="true"
      data-status-chain={status}
      className="inline-flex items-center"
    >
      {CHAIN[status].map((outcome, index) => (
        <span key={index} className="inline-flex items-center">
          {index > 0 ? <span className="h-px w-2 bg-border" /> : null}
          <RuleDot status={outcome} />
        </span>
      ))}
    </span>
  );
}
