/**
 * The insights explorer's link and its clamp: one parser for the island (which
 * reads the link) and one clamp for the server action (which reads whatever a
 * caller posts), so the two can never accept different queries.
 *
 * The link carries the window and the focus, and omits every default:
 *   from, to   YYYY-MM-DD, the window (omitted for the default window)
 *   m          "disclosed" for disclosed stakes (omitted for index funds)
 *   sector     the focused sector; "Other" is the sector of no industry
 *   stock      the focused stock's ASX code
 */

import type { InsightMeasure, InsightsPart, InsightsQuery } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STOCK = /^[A-Z0-9]{1,6}$/;
/** The API refuses a longer sector, so the clamp does too. */
export const SECTOR_MAX = 120;
/** The sector of no industry travels in the link as its printed name. */
export const OTHER_SECTOR_PARAM = "Other";

export const INSIGHT_PARAMS = ["from", "to", "m", "sector", "stock"] as const;

/** A real calendar day, written YYYY-MM-DD. */
export function isInsightDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function defaultInsightsQuery(): InsightsQuery {
  return { from: "", to: "", sector: null, stock: "" };
}

export interface InsightsLink {
  query: InsightsQuery;
  measure: InsightMeasure;
}

/** Reads the link. Anything it cannot use is dropped, never guessed. */
export function parseInsightParams(params: URLSearchParams): InsightsLink {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const sector = params.get("sector");
  const stock = (params.get("stock") ?? "").toUpperCase();
  const validFrom = isInsightDate(from) ? from : "";
  const validTo = isInsightDate(to) ? to : "";
  const ordered = validFrom && validTo && validFrom > validTo ? { from: "", to: "" } : { from: validFrom, to: validTo };
  return {
    query: {
      ...ordered,
      sector:
        sector === null || sector.length > SECTOR_MAX
          ? null
          : sector === OTHER_SECTOR_PARAM
            ? ""
            : sector,
      stock: STOCK.test(stock) ? stock : "",
    },
    measure: params.get("m") === "disclosed" ? "disclosed" : "funds",
  };
}

/** Writes the link's own parameters, defaults omitted. */
export function serialiseInsightParams(link: InsightsLink, defaultWindow: { from: string; to: string }): URLSearchParams {
  const out = new URLSearchParams();
  const { query } = link;
  const isDefaultWindow =
    (query.from === "" && query.to === "") || (query.from === defaultWindow.from && query.to === defaultWindow.to);
  if (!isDefaultWindow) {
    if (query.from) out.set("from", query.from);
    if (query.to) out.set("to", query.to);
  }
  if (link.measure === "disclosed") out.set("m", "disclosed");
  if (query.sector !== null) out.set("sector", query.sector === "" ? OTHER_SECTOR_PARAM : query.sector);
  if (query.stock) out.set("stock", query.stock);
  return out;
}

/** What a caller posts to the action: anything, so every field is checked. */
export interface InsightsQueryInput {
  from?: unknown;
  to?: unknown;
  sector?: unknown;
  stock?: unknown;
  part?: unknown;
}

export type InsightsClamp =
  | { ok: true; query: InsightsQuery; part: InsightsPart }
  | { ok: false; error: string };

/** The action's clamp: a query it can send, or why it will not send one. */
export function clampInsightsQuery(input: InsightsQueryInput): InsightsClamp {
  const from = input.from ?? "";
  const to = input.to ?? "";
  if (typeof from !== "string" || (from !== "" && !isInsightDate(from))) {
    return { ok: false, error: "from must be a date, YYYY-MM-DD" };
  }
  if (typeof to !== "string" || (to !== "" && !isInsightDate(to))) {
    return { ok: false, error: "to must be a date, YYYY-MM-DD" };
  }
  if (from !== "" && to !== "" && from > to) return { ok: false, error: "from is after to" };
  const sector = input.sector ?? null;
  if (sector !== null && (typeof sector !== "string" || sector.length > SECTOR_MAX)) {
    return { ok: false, error: `sector must be a string of at most ${SECTOR_MAX} characters` };
  }
  const stock = input.stock ?? "";
  if (typeof stock !== "string" || (stock !== "" && !STOCK.test(stock))) {
    return { ok: false, error: "stock must be an ASX code" };
  }
  const part = input.part ?? "all";
  if (part !== "all" && part !== "sector" && part !== "stock") {
    return { ok: false, error: "part must be all, sector or stock" };
  }
  if (part === "sector" && sector === null) return { ok: false, error: "a sector part needs a sector" };
  if (part === "stock" && stock === "") return { ok: false, error: "a stock part needs a stock" };
  return { ok: true, query: { from, to, sector, stock }, part };
}

/** The server page's view: the default window, no focus, the whole answer. */
export function isDefaultInsightsQuery(query: InsightsQuery, part: InsightsPart): boolean {
  return part === "all" && query.from === "" && query.to === "" && query.sector === null && query.stock === "";
}
