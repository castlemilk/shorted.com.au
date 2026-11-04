"use client";

import { Inspector } from "../workspace/inspector";
import type { InspectorContent, InspectorResolver } from "../workspace/inspector-types";
import type { Selection } from "../workspace/selection";
import { cleanIsoDate } from "./fund-model";
import type { ChangeRangeResolver } from "./changes-inspector";
import { withUrlState, type UrlState } from "./url-params";

/** A holding's resolver for the file the page shows ("" for the newest). */
export type FundHoldingResolver = (selection: Selection, view: { asAt?: string }) => Promise<InspectorContent | null>;

export interface FundRailProps {
  /** The holding and fund resolver (the Portfolio tab). */
  resolve: FundHoldingResolver;
  /** The change resolver for the Changes tab, over the comparison the URL names. */
  changes: ChangeRangeResolver;
  /** The fund's default comparison, read when the URL names no dates. */
  defaults: { from: string; to: string };
  emptyText: string;
}

/**
 * The fund page's rail (spec 14.1, 14.3): the Portfolio tab's holding resolves in the
 * snapshot the page shows (`?as=`); the Changes tab's row resolves against the two
 * dates the table shows (`?from=`, `?to=`, else the page's defaults). The tab is read
 * from the URL here, so the page itself reads no search parameter.
 */
export function FundRailView({ resolve, changes, defaults, emptyText, params }: FundRailProps & UrlState) {
  const onChanges = params.get("tab") === "changes";
  const from = cleanIsoDate(params.get("from")) || defaults.from;
  const to = cleanIsoDate(params.get("to")) || defaults.to;
  const asAt = cleanIsoDate(params.get("as"));
  const bound: InspectorResolver = onChanges
    ? (selection) => changes(selection, { from, to })
    : (selection) => resolve(selection, { asAt });
  return <Inspector resolve={bound} emptyText={emptyText} />;
}

/** The fund page's rail, reading its tab and dates from the URL under its own boundary. */
export const FundRail = withUrlState(FundRailView);
