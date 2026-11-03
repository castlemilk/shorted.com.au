"use client";

/**
 * The time window: a two-handle range over every date on record, with presets,
 * step buttons and play. It drives every view on the page.
 *
 * Each handle is a native range input, so the keyboard and screen readers get a
 * real slider for free (arrow keys move a day, Page Up and Page Down move more).
 * Under the track, the months show how many notices were read and the fund files
 * are ticks, so a reader sees where a window can say something before moving it.
 * Dragging moves the handles at once and asks the server only when the window
 * settles.
 */

import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { addDays, addMonths, daysBetween, windowText } from "~/@/lib/ownership/insights/format";
import type { InsightTimelineRow } from "~/@/lib/ownership/insights/types";
import { cn } from "~/@/lib/utils";

export interface TimeWindowProps {
  timelineFrom: string;
  timelineTo: string;
  from: string;
  to: string;
  snapshotDates: readonly string[];
  timeline: readonly InsightTimelineRow[];
  bucket: "week" | "month" | "";
  playing: boolean;
  disabled?: boolean;
  onChange: (from: string, to: string) => void;
  onPlay: () => void;
}

/** How long the handles must rest before the server is asked. */
export const SETTLE_MS = 350;

const PRESETS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "All", days: null },
];

/**
 * Two native ranges share one track: the inputs ignore the pointer and only
 * their thumbs take it, so either handle can be grabbed wherever it sits.
 */
const RANGE =
  "pointer-events-none absolute inset-x-0 top-[22px] h-6 w-full appearance-none bg-transparent focus-visible:outline-none " +
  "[&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-solid [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-solid [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background " +
  "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring focus-visible:[&::-webkit-slider-thumb]:ring-offset-2 focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-ring " +
  "disabled:[&::-webkit-slider-thumb]:cursor-not-allowed disabled:[&::-webkit-slider-thumb]:opacity-50";

const BUTTON =
  "hit-target inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground transition-colors duration-150 hover:border-input hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** The window one step along: a week for a week-bucketed window, a month otherwise, its length kept. */
export function stepWindow(
  from: string,
  to: string,
  direction: 1 | -1,
  bucket: "week" | "month" | "",
  timelineFrom: string,
  timelineTo: string,
): { from: string; to: string } {
  const length = daysBetween(from, to);
  let nextTo = bucket === "month" ? addMonths(to, direction) : addDays(to, 7 * direction);
  if (nextTo > timelineTo) nextTo = timelineTo;
  let nextFrom = addDays(nextTo, -length);
  if (nextFrom < timelineFrom) {
    nextFrom = timelineFrom;
    nextTo = addDays(nextFrom, length) > timelineTo ? timelineTo : addDays(nextFrom, length);
  }
  return { from: nextFrom, to: nextTo };
}

export function TimeWindow({
  timelineFrom,
  timelineTo,
  from,
  to,
  snapshotDates,
  timeline,
  bucket,
  playing,
  disabled,
  onChange,
  onPlay,
}: TimeWindowProps) {
  const id = useId();
  const noTimeline = !timelineFrom || !timelineTo;
  const span = noTimeline ? 1 : Math.max(1, daysBetween(timelineFrom, timelineTo));
  const [draft, setDraft] = useState({ from, to });
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The window on screen moves the handles, unless the reader is dragging them.
  useEffect(() => {
    if (settle.current === null) setDraft({ from, to });
  }, [from, to]);
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);

  const lo = noTimeline || !draft.from ? 0 : Math.max(0, Math.min(span, daysBetween(timelineFrom, draft.from)));
  const hi = noTimeline || !draft.to ? span : Math.max(0, Math.min(span, daysBetween(timelineFrom, draft.to)));

  const commit = (nextFrom: string, nextTo: string) => {
    setDraft({ from: nextFrom, to: nextTo });
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      onChange(nextFrom, nextTo);
    }, SETTLE_MS);
  };

  const months = useMemo(() => {
    if (noTimeline) return [];
    const peak = Math.max(1, ...timeline.map((m) => m.notices));
    return timeline.map((m) => ({
      ...m,
      x: Math.max(0, daysBetween(timelineFrom, `${m.month}-01`)) / span,
      h: m.notices / peak,
    }));
  }, [timeline, timelineFrom, span, noTimeline]);
  const monthWidth = timeline.length > 0 ? 1 / timeline.length : 0;
  const ticks = useMemo(
    () => (noTimeline ? [] : snapshotDates.map((d) => Math.max(0, Math.min(1, daysBetween(timelineFrom, d) / span)))),
    [snapshotDates, timelineFrom, span, noTimeline],
  );

  const step = (direction: 1 | -1) => {
    const next = stepWindow(from, to, direction, bucket, timelineFrom, timelineTo);
    commit(next.from, next.to);
  };
  const preset = (days: number | null) => {
    if (days === null) return commit(timelineFrom, timelineTo);
    const nextFrom = addDays(timelineTo, -(days - 1));
    commit(nextFrom < timelineFrom ? timelineFrom : nextFrom, timelineTo);
  };

  const inactive = disabled === true || noTimeline;
  const atEnd = to >= timelineTo;
  const atStart = from <= timelineFrom;
  const length = noTimeline || !draft.from || !draft.to ? 0 : daysBetween(draft.from, draft.to) + 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p id={`${id}-label`} className="text-sm">
          <span className="text-muted-foreground">Window </span>
          {noTimeline ? (
            <span>n/a</span>
          ) : (
            <span className="font-medium tabular-nums">
              <time dateTime={draft.from}>{draft.from}</time> to <time dateTime={draft.to}>{draft.to}</time>
              <span className="font-normal text-muted-foreground"> ({length.toLocaleString("en-AU")} days)</span>
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Window presets">
          {PRESETS.map((p) => {
            const isActive =
              !noTimeline &&
              draft.to === timelineTo &&
              (p.days === null ? draft.from === timelineFrom : length === p.days);
            return (
              <button
                key={p.label}
                type="button"
                disabled={inactive}
                aria-pressed={isActive}
                onClick={() => preset(p.days)}
                className={cn(BUTTON, isActive && "border-primary/60 bg-primary/10 font-semibold text-primary")}
              >
                {p.label}
              </button>
            );
          })}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <button type="button" className={BUTTON} disabled={inactive || atStart} onClick={() => step(-1)} aria-label={bucket === "month" ? "Step back a month" : "Step back a week"}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className={cn(BUTTON, "min-w-[5.5rem]")}
            disabled={inactive || (atEnd && atStart && !playing)}
            onClick={onPlay}
            aria-pressed={playing}
          >
            {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            {playing ? "Pause" : atEnd ? "Replay" : "Play"}
          </button>
          <button type="button" className={BUTTON} disabled={inactive || atEnd} onClick={() => step(1)} aria-label={bucket === "month" ? "Step forward a month" : "Step forward a week"}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="relative h-14">
        {/* The record under the track: notices per month, and a tick for each fund file. */}
        <svg className="absolute inset-x-0 top-0 h-8 w-full" viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden>
          {months.map((m) => (
            <rect
              key={m.month}
              x={m.x * 1000 + 1}
              y={32 - Math.max(1, m.h * 26)}
              width={Math.max(1, monthWidth * 1000 - 2)}
              height={Math.max(1, m.h * 26)}
              className="fill-muted-foreground/25"
            />
          ))}
          {ticks.map((x, i) => (
            <rect key={i} x={x * 1000 - 1} y={2} width={2} height={30} className="fill-primary/70" />
          ))}
          <rect
            x={(lo / span) * 1000}
            y={0}
            width={Math.max(2, ((hi - lo) / span) * 1000)}
            height={32}
            className="fill-primary/10"
          />
        </svg>
        <div className="absolute inset-x-0 top-8 h-1.5 rounded-full bg-muted">
          <div
            className="absolute h-1.5 rounded-full bg-primary"
            style={{ left: `${(lo / span) * 100}%`, width: `${((hi - lo) / span) * 100}%` }}
          />
        </div>
        {(["from", "to"] as const).map((handle) => (
          <input
            key={handle}
            type="range"
            min={0}
            max={span}
            step={1}
            value={handle === "from" ? lo : hi}
            disabled={inactive}
            aria-label={handle === "from" ? "Window start" : "Window end"}
            aria-valuetext={handle === "from" ? draft.from : draft.to}
            aria-describedby={`${id}-label`}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (handle === "from") {
                const nextFrom = addDays(timelineFrom, Math.min(v, hi));
                commit(nextFrom, draft.to);
              } else {
                const nextTo = addDays(timelineFrom, Math.max(v, lo));
                commit(draft.from, nextTo);
              }
            }}
            className={RANGE}
          />
        ))}
        <div className="absolute inset-x-0 top-11 flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <time dateTime={timelineFrom}>{timelineFrom}</time>
          <span className="hidden sm:inline">
            {snapshotDates.length.toLocaleString("en-AU")} fund file dates, notices by month
          </span>
          <time dateTime={timelineTo}>{timelineTo}</time>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {noTimeline ? "" : `Window ${windowText(from, to)}`}
      </p>
    </div>
  );
}
