/**
 * The retired insights explorer's links, read into the map's link (spec 14.10). The
 * explorer's own page and codec are gone: a link to /ownership/insights answers a 308
 * to the desk's map, and this is the one place that says where each parameter lands.
 *
 *   sector      verbatim, the map's zoomed sector
 *   stock=C     sel=stock:C, the workspace selection
 *   m=disclosed lens=flow (the notices' net change); otherwise lens=index_flow
 *   from, to    the index fund window (two snapshot dates)
 *   the same pair as a notice window: since/until when the API serves it (366 days at most),
 *               else window=364 when the span is longer, else nothing
 *
 * A PURE MODULE: the route reads the request, this writes the query.
 */

import { DEFAULT_DESK_STATE, DESK_MAX_SPAN_DAYS, dayGap, isIsoDate, isServedNoticePair, shiftDate, writeDeskState, type DeskState } from "~/@/components/ownership/desk/desk-state";

/** The widest window the desk's chips name, which a longer span is folded to. */
const LONGEST_CHIP_WINDOW = 364;
const STOCK_CODE = /^[A-Z0-9]{1,6}$/;

/** The map's query string for a retired insights link, without its "?". A bare request is the index fund lens. */
export function insightsRedirectQuery(params: URLSearchParams): string {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  // One date alone, or an inverted pair, is no fund window.
  const ordered = isIsoDate(from) && isIsoDate(to) && from <= to ? { from, to } : { from: "", to: "" };
  const stock = (params.get("stock") ?? "").toUpperCase();
  // The API refuses a fund window longer than DESK_MAX_SPAN_DAYS, so a longer pair keeps its
  // end date and starts LONGEST_CHIP_WINDOW days before it (the map then draws a served window).
  const longFund = ordered.from !== "" && dayGap(ordered.from, ordered.to) > DESK_MAX_SPAN_DAYS;
  const state: DeskState = {
    ...DEFAULT_DESK_STATE,
    lens: params.get("m") === "disclosed" ? "flow" : "index_flow",
    sector: params.get("sector") ?? "",
    sel: STOCK_CODE.test(stock) ? `stock:${stock}` : "",
    from: longFund ? shiftDate(ordered.to, -LONGEST_CHIP_WINDOW) : ordered.from,
    to: ordered.to,
  };
  if (ordered.from !== "") {
    if (isServedNoticePair(ordered.from, ordered.to)) {
      state.since = ordered.from;
      state.until = ordered.to;
    } else if (longFund) {
      state.window = LONGEST_CHIP_WINDOW;
    }
  }
  return writeDeskState(state);
}

/** The map's path and query a retired insights link redirects to. */
export function insightsRedirectPath(params: URLSearchParams): string {
  const query = insightsRedirectQuery(params);
  return query === "" ? "/ownership/map" : `/ownership/map?${query}`;
}
