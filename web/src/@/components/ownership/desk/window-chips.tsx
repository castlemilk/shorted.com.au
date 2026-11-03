import Link from "next/link";
import { cn } from "~/@/lib/utils";
import { POLITICS_FOCUS_RING } from "~/@/lib/politics/control-classes";
import {
  DEFAULT_DESK_WINDOW,
  DESK_WINDOWS,
  isIsoDate,
  shiftDate,
  windowDates,
  writeNoticeWindow,
  type DeskWindow,
  type NoticeWindow,
} from "./desk-state";

// The window of change the map, the flows and the movement share (spec 13.1,
// 13.4). Two parameters name it: `window` (a count of days back from the newest
// notice read, the chips) and `since` with `until` (a brushed pair of notice
// release dates). The codec lives in desk-state.ts, the one place a value is
// accepted; this module draws the chips and the prose and re-exports the codec,
// so the instruments read and write the state one way.
//
// A brushed pair is NOT `from` and `to`. Those are the index fund window's two
// snapshot dates (desk-state.ts), a different parameter that moves a different
// instrument, so a notice window never writes them.
//
// A PLAIN MODULE. It holds no state and no hooks, so the server default view and
// the islands draw the same chips.

export { readNoticeWindow, writeNoticeWindow, type NoticeWindow } from "./desk-state";

/** The window the default view draws: the default chip, no brush. */
export const DESK_DEFAULT_WINDOW_STATE: NoticeWindow = {
  window: DEFAULT_DESK_WINDOW,
  since: "",
  until: "",
};

/** A link's path and query: the bare path when there is no query. */
export function hrefWithParams(path: string, params: URLSearchParams): string {
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The link to a window, keeping every other parameter the reader has. */
export function noticeWindowHref(
  basePath: string,
  current: URLSearchParams,
  next: NoticeWindow,
): string {
  const params = new URLSearchParams(current);
  writeNoticeWindow(params, next);
  return hrefWithParams(basePath, params);
}

/**
 * The link that sets one parameter (or clears it, with null), keeping the rest.
 * Used for the zoomed sector, which the map reads.
 */
export function deskParamHref(
  basePath: string,
  current: URLSearchParams,
  patch: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(current);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === "") params.delete(name);
    else params.set(name, value);
  }
  return hrefWithParams(basePath, params);
}

/** The window as prose, with no markup: "over the last 91 days", "since 2026-08-01", "from 2026-08-01 to 2026-10-31". */
export function windowPhraseText(state: NoticeWindow, asOf: string): string {
  if (state.since === "") return `over the last ${state.window} days`;
  if (asOf !== "" && state.until === asOf) return `since ${state.since}`;
  return `from ${state.since} to ${state.until}`;
}

/** The notice window's start and end, for a brushed or chip window, given the newest notice. Null when it has none. */
export function noticeWindowDates(
  state: NoticeWindow,
  asOf: string,
): { from: string; to: string } | null {
  if (state.since !== "") return { from: state.since, to: state.until };
  return windowDates(state.window, asOf);
}

/** The chip a brushed pair equals, when it spans exactly a chip's days ending on the newest notice. */
export function chipForBrush(since: string, until: string, asOf: string): DeskWindow | null {
  if (!isIsoDate(since) || !isIsoDate(until) || !isIsoDate(asOf) || until !== asOf) return null;
  for (const days of DESK_WINDOWS) {
    if (shiftDate(asOf, -(days - 1)) === since) return days;
  }
  return null;
}

const CHIP_CLASS = cn(
  "inline-flex h-9 items-center rounded-md border px-3 text-xs tabular-nums transition-colors duration-150 motion-reduce:transition-none",
  POLITICS_FOCUS_RING,
);

export interface WindowChipsProps {
  /** The group's accessible name. */
  label?: string;
  /** The window the page is showing; a brushed window matches no chip. */
  active: NoticeWindow;
  /** The link a chip follows. The caller keeps the reader's other parameters. */
  hrefFor: (next: NoticeWindow) => string;
}

/**
 * The window chips: one link per served window. A chip is a `replace` link with
 * no prefetch, so a change of window moves the URL and nothing else, and the
 * instruments that read it redraw from the link.
 */
export function WindowChips({ label = "Window of change", active, hrefFor }: WindowChipsProps) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {DESK_WINDOWS.map((days) => {
        const next: NoticeWindow = { window: days, since: "", until: "" };
        const on = active.since === "" && active.window === days;
        return (
          <Link
            key={days}
            href={hrefFor(next)}
            replace
            scroll={false}
            prefetch={false}
            rel="nofollow"
            aria-current={on ? "true" : undefined}
            className={cn(
              CHIP_CLASS,
              on
                ? "border-primary/60 bg-primary/10 font-semibold text-primary"
                : "border-border text-muted-foreground hover:border-input hover:text-foreground",
            )}
          >
            {`${days} days`}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * The window as a caption fragment, its dates in `<time>` elements: "over the last
 * 91 days", "since <time>2026-08-01</time>", "from <time>...</time> to <time>...</time>".
 */
export function WindowPhrase({ state, asOf }: { state: NoticeWindow; asOf: string }) {
  if (state.since === "") return <>over the last {state.window} days</>;
  if (asOf !== "" && state.until === asOf) {
    return (
      <>
        since <time dateTime={state.since}>{state.since}</time>
      </>
    );
  }
  return (
    <>
      from <time dateTime={state.since}>{state.since}</time> to{" "}
      <time dateTime={state.until}>{state.until}</time>
    </>
  );
}
