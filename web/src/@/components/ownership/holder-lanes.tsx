import Link from "next/link";
import { Disclosure } from "~/@/components/ui/disclosure";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { VIEW_H, VIEW_W, type HolderLane, type YearLabel } from "~/@/lib/ownership/trace";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "~/@/lib/utils";
import { ExternalLinkGlyph } from "./external-link-glyph";
import { KindBadge } from "./kind-badge";
import { Dated } from "./ownership-provenance";

// Server-safe: no "use client", no Connect import. Holder Lanes draws the
// geometry lib/ownership/trace.ts returns: one lane per holder, its holding
// stepping at each notice read. Every figure a lane shows is also text beside
// it, and the Notices table is the data behind the picture, so a lane needs no
// pointer and no client code.

// From `sm` the lane row and the axis share one grid, so the axis sits under the lanes.
const LANE_COLUMNS = "sm:grid-cols-[minmax(0,176px)_minmax(0,1fr)_112px_88px_32px]";

// A year label that starts this far along the axis would run past a phone's right
// edge, so it hangs left of its tick instead.
const HANG_FROM_X = 950;

// Below `sm` the row is two lines: the name, the figure with its change under
// it, and the ASX glyph on the first; the lane across the second. From `sm` the
// readout's wrapper is `contents`, so its figure and change take their own columns.
const ROW = [
  "grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 py-2",
  "[grid-template-areas:'name_readout_glyph'_'lane_lane_lane']",
  "sm:py-0 sm:grid-cols-[minmax(0,176px)_minmax(0,1fr)_112px_88px_32px]",
  "sm:[grid-template-areas:'name_lane_readout_change_glyph']",
].join(" ");

const SR_SENTENCE = "The notices behind each line are listed in the Notices table below.";

const AGE_TITLE =
  "No later notice read: the holding may have moved by under 1 percentage point, or a later notice may be one we withheld or one filed under another name.";

function lanesCaption(from: string, to: string): string {
  return `One line per holder, stepping at each notice read, on its own scale from 5% up: a small step on a large holding is slight here and exact in the figures beside it. Flat between notices means no later notice was read: a holding can move by less than the 1 percentage point that requires a new notice, and a notice we withheld is not drawn. A line ending at the 5% edge is a cessation (Form 605): under 5%, not zero. A dotted tail is the time since the holder's last notice read; a dotted lead-in is the previous figure the first notice drawn states. A notice without an event date sits on its release date. From ${from || NOT_AVAILABLE} to ${to || NOT_AVAILABLE}.`;
}

function truncatedCopy(historyTotal: number): string {
  return `The latest 100 of ${historyTotal.toLocaleString("en-AU")} notices; earlier notices are not drawn. `;
}

function withheldCopy(n: number, code: string): string {
  const noun = n === 1 ? "notice" : "notices";
  const verb = n === 1 ? "was" : "were";
  return `${n.toLocaleString("en-AU")} ${noun} listed under ${code} ${verb} withheld: not read or not reconcilable, never estimated.`;
}

function moreHolders(n: number): string {
  return `${n} more ${n === 1 ? "holder" : "holders"}`;
}

export interface HolderLanesProps {
  lanes: readonly HolderLane[];
  /** The first and last day the axis covers. */
  from: string;
  to: string;
  yearLabels: readonly YearLabel[];
  /** The history is the newest slice of more notices than it holds. */
  truncated: boolean;
  /** The stock's ASX code, for the withheld sentence. */
  code: string;
  historyTotal: number;
  /** Notices listed under this stock that were withheld. */
  withheldListed: number;
  /** Lanes drawn before the rest wait behind a disclosure. */
  maxLanes?: number;
}

function LaneRow({ lane }: { lane: HolderLane }) {
  const asx = safeExternalHref(lane.url);
  return (
    <li className={ROW}>
      <div className="min-w-0 [grid-area:name]">
        {/* leading-6 makes the line 24px tall, so the link's hit target fits inside the truncating box. */}
        <span className="block truncate text-sm leading-6" title={lane.name}>
          {lane.href ? (
            <Link
              href={lane.href}
              prefetch={false}
              className="hit-target text-primary underline-offset-4 hover:underline"
            >
              {lane.name}
            </Link>
          ) : (
            lane.name
          )}
        </span>
        <KindBadge kind={lane.kind} />
      </div>
      <div title={`Lane scale 5% to ${lane.scaleHi}%`} className="min-w-0 [grid-area:lane]">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block h-7 w-full"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d={lane.paths.threshold}
            fill="none"
            vectorEffect="non-scaling-stroke"
            stroke="hsl(var(--border))"
            strokeWidth={1}
            strokeDasharray="4 6"
          />
          {lane.paths.dotted.map((d, index) => (
            <path
              key={`dotted-${index}`}
              d={d}
              fill="none"
              vectorEffect="non-scaling-stroke"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={1}
              strokeDasharray="4 6"
            />
          ))}
          {lane.paths.solid.map((d, index) => (
            <path
              key={`solid-${index}`}
              d={d}
              fill="none"
              vectorEffect="non-scaling-stroke"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeLinejoin="miter"
            />
          ))}
          {lane.paths.ticks.map((d, index) => (
            <path
              key={`tick-${index}`}
              d={d}
              fill="none"
              vectorEffect="non-scaling-stroke"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
          {lane.paths.ends.map((d, index) => (
            <path
              key={`end-${index}`}
              d={d}
              fill="none"
              vectorEffect="non-scaling-stroke"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
        </svg>
      </div>
      <div className="text-right [grid-area:readout] sm:contents">
        <div className="[grid-area:readout]">
          <div className="text-sm tabular-nums">{lane.figure}</div>
          <div className="text-[10px] tabular-nums text-muted-foreground">
            {lane.asAt ? <time dateTime={lane.asAt}>{lane.asAt}</time> : NOT_AVAILABLE}
            {lane.age ? (
              <>
                {" · "}
                <span title={AGE_TITLE} data-age-months={Number.parseInt(lane.age, 10)}>
                  {lane.age}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="text-xs tabular-nums [grid-area:change]">{lane.change || NOT_AVAILABLE}</div>
      </div>
      {asx ? (
        <a
          href={asx}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${lane.name}'s notice on ASX`}
          className="hit-target justify-self-end text-muted-foreground hover:text-primary [grid-area:glyph]"
        >
          <ExternalLinkGlyph />
        </a>
      ) : null}
    </li>
  );
}

export function HolderLanes({
  lanes,
  from,
  to,
  yearLabels,
  truncated,
  code,
  historyTotal,
  withheldListed,
  maxLanes = 12,
}: HolderLanesProps) {
  if (lanes.length === 0) return null;
  const drawn = lanes.slice(0, maxLanes);
  const rest = lanes.slice(maxLanes);

  return (
    <figure aria-labelledby="holders" aria-describedby="lanes-method">
      <p className="sr-only">{SR_SENTENCE}</p>
      <ol className="divide-y divide-border/60">
        {drawn.map((lane) => (
          <LaneRow key={lane.holderKey} lane={lane} />
        ))}
      </ol>
      {rest.length > 0 ? (
        <Disclosure title={moreHolders(rest.length)}>
          <ol start={maxLanes + 1} className="divide-y divide-border/60 text-foreground">
            {rest.map((lane) => (
              <LaneRow key={lane.holderKey} lane={lane} />
            ))}
          </ol>
        </Disclosure>
      ) : null}
      <div className={cn("mt-2 grid gap-x-3", LANE_COLUMNS)}>
        <div className="relative h-4 sm:col-start-2">
          {yearLabels.map((year) => (
            <span
              key={year.label}
              className={cn(
                "absolute top-0 text-[10px] tabular-nums text-muted-foreground",
                year.x > HANG_FROM_X && "-translate-x-full",
              )}
              style={{ left: `${year.x / 10}%` }}
            >
              {year.label}
            </span>
          ))}
        </div>
      </div>
      <figcaption id="lanes-method" className="mt-3 text-xs leading-5 tabular-nums text-muted-foreground">
        {truncated ? truncatedCopy(historyTotal) : null}
        <Dated text={lanesCaption(from, to)} />
        {withheldListed > 0 ? ` ${withheldCopy(withheldListed, code)}` : null}
      </figcaption>
    </figure>
  );
}
