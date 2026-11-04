"use client";

import { Inspector } from "../workspace/inspector";
import type { InspectorContent, InspectorResolver } from "../workspace/inspector-types";
import type { Selection } from "../workspace/selection";
import { cleanIsoDate } from "./fund-model";
import { withUrlState, type UrlState } from "./url-params";

/** A change's resolver: the selection and the two file dates the comparison uses. */
export type ChangeRangeResolver = (
  selection: Selection,
  range: { from: string; to: string },
) => Promise<InspectorContent | null>;

export interface ChangesInspectorProps {
  resolve: ChangeRangeResolver;
  /**
   * The page's default comparison: its fund and the two file dates it uses. Those dates
   * are read when the URL names none, and only for that fund; another fund's comparison
   * takes its own dates from the URL (the table writes them there once read).
   */
  defaults: { fund?: string; from: string; to: string };
}

/**
 * The rail of the Changes page (spec 14.1, 14.3): the workspace inspector, resolving a
 * selected row against the comparison the URL names (`?from=` and `?to=`). It is a
 * client island because the dates live in the URL; the resolver arrives as a prop, so
 * no client module imports the action.
 */
export function ChangesInspectorView({ resolve, defaults, params }: ChangesInspectorProps & UrlState) {
  const urlFrom = cleanIsoDate(params.get("from"));
  const urlTo = cleanIsoDate(params.get("to"));
  const bound: InspectorResolver = (selection) => {
    const otherFund = selection.kind === "holding" && defaults.fund !== undefined && selection.fundKey !== defaults.fund;
    if (otherFund) return resolve(selection, { from: urlFrom, to: urlTo });
    return resolve(selection, { from: urlFrom || defaults.from, to: urlTo || defaults.to });
  };
  return <Inspector resolve={bound} emptyText="Select a row to inspect the change." />;
}

/** The Changes rail, reading its comparison from the URL under its own boundary. */
export const ChangesInspector = withUrlState(ChangesInspectorView);
