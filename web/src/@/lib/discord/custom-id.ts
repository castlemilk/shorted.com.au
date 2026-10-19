import {
  isChartPeriod,
  isChartViewId,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";

/**
 * Message components carry their state in their `custom_id` (at most 100
 * characters), so the bot keeps none: a button on a chart says which chart it
 * draws, and the endpoint redraws exactly that. A message posted a month ago
 * still works after a deploy, and no store is needed to serve it.
 *
 *   chart:v:BHP:price:1y     a view button on a chart message
 *   chart:p:BHP:short:3m     a period button on a chart message
 *   activity:BHP:short:1y    launches the Activity at that chart
 *   pick                     a stock select menu (the code is the value)
 *
 * The `v`/`p` segment exists because Discord rejects a message whose
 * components share a custom_id, and the view button for the view on screen
 * and the period button for the period on screen both lead to the same chart.
 *
 * The Activity reads the same string from its launch URL (`?custom_id=`), so
 * this module stays free of anything that cannot run in a browser.
 */

export interface ChartState {
  code: string;
  view: ChartViewId;
  period: ChartPeriod;
}

export type ParsedCustomId =
  | { kind: "chart"; state: ChartState }
  | { kind: "activity"; state: ChartState }
  | { kind: "pick" };

const CODE_RE = /^[A-Z0-9]{2,6}$/;

/** An ASX code as Discord users type it ("bhp ", "$BHP", "ASX:BHP"), or null. */
export function normalizeCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/^ASX:/, "")
    .replace(/^\$/, "");
  return CODE_RE.test(code) ? code : null;
}

function encodeState({ code, view, period }: ChartState): string {
  return `${code}:${view}:${period}`;
}

function parseState(parts: string[]): ChartState | null {
  const [rawCode, view, period] = parts;
  const code = normalizeCode(rawCode);
  if (!code || !isChartViewId(view) || !isChartPeriod(period)) return null;
  return { code, view, period };
}

export const PICK_CUSTOM_ID = "pick";

export function chartCustomId(
  control: "view" | "period",
  state: ChartState,
): string {
  return `chart:${control === "view" ? "v" : "p"}:${encodeState(state)}`;
}

export function activityCustomId(state: ChartState): string {
  return `activity:${encodeState(state)}`;
}

export function parseCustomId(
  id: string | null | undefined,
): ParsedCustomId | null {
  if (!id) return null;
  if (id === PICK_CUSTOM_ID) return { kind: "pick" };
  const parts = id.split(":");
  if (parts[0] === "chart" && (parts[1] === "v" || parts[1] === "p")) {
    const state = parts.length === 5 ? parseState(parts.slice(2)) : null;
    return state ? { kind: "chart", state } : null;
  }
  if (parts[0] === "activity") {
    const state = parts.length === 4 ? parseState(parts.slice(1)) : null;
    return state ? { kind: "activity", state } : null;
  }
  return null;
}
