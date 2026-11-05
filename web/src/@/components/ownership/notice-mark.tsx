import type { ReactNode } from "react";

import { isNoticeEvent, type NoticeEvent } from "~/@/lib/ownership/query";
import { cn } from "~/@/lib/utils";

// Server-safe and client-safe: no "use client", no Connect import. The notice
// feed's island ships it, and a page may draw one beside a count.
//
// A notice's event as a shape, never a colour. The row's text names the event
// and the mark only repeats it, so the mark takes the row's ink (currentColor).
// Red and green are the direction of a market number and nothing else, so a
// mark is never either: a fall is a chevron down, not a warning.

const MARKS: Readonly<Record<NoticeEvent, ReactNode>> = {
  // A rise from the baseline, capped: the notice that made the holder substantial,
  // the step the lanes draw up from the 5% edge. A stroke like the other five.
  became: <path d="M3 10.5V3.5h10" />,
  increased: <path d="M3.5 8.5 8 4l4.5 4.5" />,
  decreased: <path d="M3.5 3.5 8 8l4.5-4.5" />,
  changed: <path d="M3 6h10" />,
  // A strike on the baseline: the holding ends on the 5% edge, as the lanes draw it.
  ceased: (
    <>
      <path d="M1.5 10.5h13" />
      <path d="M12.5 7v3.5" />
    </>
  ),
  nz: <circle cx="8" cy="6" r="3.5" />,
};

/** The title of the model-read mark: what a model's reading rests on. */
export const MODEL_READ_TITLE = "Read by a model, two readers agreed; validated against the share count";

/**
 * The small muted mark a notice read by a model carries (read_by = model). The parser's
 * notices carry none: the mark is the exception, so a reader sees which figures a model read.
 */
export function ModelReadMark() {
  return (
    <span title={MODEL_READ_TITLE} className="ml-2 whitespace-nowrap text-xs text-muted-foreground">
      model-read
    </span>
  );
}

/** A notice's event as a fixed 16 by 12 pictogram. An event the build does not know draws nothing. */
export function NoticeMark({ event, className }: { event: string; className?: string }) {
  if (!isNoticeEvent(event)) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-3 w-4 shrink-0", className)}
    >
      {MARKS[event]}
    </svg>
  );
}
