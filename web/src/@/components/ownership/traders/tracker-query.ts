"use client";

import { useSyncExternalStore } from "react";
import {
  filingEvents,
  type FilingEvent,
  type FilingOrder,
} from "~/@/lib/ownership/investor-activity";

const views = ["investors", "filings", "ranks", "following"] as const;
export type TrackerView = (typeof views)[number];
export type TrackerQuery = {
  view: TrackerView;
  query: string;
  event: FilingEvent | "";
  order: FilingOrder;
  largestStake: boolean;
  titled: boolean;
  unread: boolean;
  page: number;
};
export const defaultView: TrackerQuery = {
  view: "investors",
  query: "",
  event: "",
  order: "latest",
  largestStake: false,
  titled: false,
  unread: false,
  page: 1,
};

export function parseTrackerQuery(search: string): TrackerQuery {
  const p = new URLSearchParams(search);
  const view = views.find((v) => v === p.get("view")) ?? "investors";
  const withFilings = view === "filings" || view === "following";
  const order = p.get("sort");
  const page = Number(p.get("page"));
  return {
    view,
    query: (p.get("q") ?? "").slice(0, 200),
    event: withFilings
      ? (filingEvents.find((v) => v === p.get("event")) ?? "")
      : "",
    order:
      withFilings && (order === "power" || order === "move") ? order : "latest",
    largestStake: view === "ranks" && order === "stake",
    titled: view === "filings" && p.get("titled") === "1",
    unread: view === "following" && p.get("unread") === "1",
    page: withFilings && Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

const changeEvent = "shorted:investor-tracker-navigation";
const currentSearch = () => window.location.search;
const serverSearch = () => "";
function subscribe(update: () => void) {
  window.addEventListener("popstate", update);
  window.addEventListener(changeEvent, update);
  return () => {
    window.removeEventListener("popstate", update);
    window.removeEventListener(changeEvent, update);
  };
}

export function useTrackerQuery() {
  const search = useSyncExternalStore(subscribe, currentSearch, serverSearch);
  return parseTrackerQuery(search);
}

export function updateTrackerQuery(
  changes: Partial<TrackerQuery>,
  push = false,
) {
  const url = new URL(window.location.href);
  const next = { ...parseTrackerQuery(url.search), page: 1, ...changes };
  const values = {
    view: next.view === "investors" ? "" : next.view,
    q: next.query,
    event: next.event,
    sort: next.largestStake
      ? "stake"
      : next.order === "latest"
        ? ""
        : next.order,
    titled: next.titled ? "1" : "",
    unread: next.unread ? "1" : "",
    page: next.page > 1 ? String(next.page) : "",
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(changeEvent));
}
