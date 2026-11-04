"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { withUrlState, type UrlState } from "./url-params";
import { patchHref, parseTab } from "./fund-model";

export interface UrlTab<T extends string> {
  id: T;
  label: string;
  panel: ReactNode;
}

export interface UrlTabsProps<T extends string> {
  /** The tab list's accessible name. */
  label: string;
  tabs: readonly UrlTab<T>[];
  /** The tab the URL does not name, or names wrongly. */
  defaultTab: T;
  /** The query parameter the tab is read from. */
  param?: string;
  /**
   * A tab a URL names by its parameters when it names no tab: a link built by a panel
   * that keeps only its own parameters (the notice feed's chips) still lands on it.
   * The names are data, so a server page can pass them.
   */
  inferFrom?: { tab: T; when: readonly string[] };
}

/**
 * A tab strip whose selection is a query parameter (spec 14.3): the active panel is
 * the one the URL names, every other panel is left out of the DOM. The page passes
 * each panel already built, so the server renders the default tab and the island
 * only chooses among them. Each tab is a button in a tablist, selected with
 * `aria-selected`; a choice writes the parameter and nothing else.
 */
export function UrlTabsView<T extends string>({
  label,
  tabs,
  defaultTab,
  param = "tab",
  inferFrom,
  params,
  pathname,
  navigate,
}: UrlTabsProps<T> & UrlState) {
  const ids = tabs.map((tab) => tab.id);
  const inferred =
    inferFrom !== undefined && !params.has(param) && inferFrom.when.some((name) => params.has(name))
      ? inferFrom.tab
      : null;
  const active = parseTab(params.get(param) ?? inferred, ids, defaultTab);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() =>
                navigate(patchHref(pathname, params, { [param]: tab.id === defaultTab ? null : tab.id }))
              }
              className={cn(
                "-mb-px border-b-2 px-3 py-2 font-mono text-sm transition-colors",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={current?.label}>
        {current?.panel}
      </div>
    </div>
  );
}

/** The tab strip, reading its selection from the URL under its own boundary. */
export const UrlTabs = withUrlState(UrlTabsView);
