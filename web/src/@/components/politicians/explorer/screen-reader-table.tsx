/**
 * The chart data table a screen reader gets, clipped so it cannot move the page.
 *
 * WHY THIS COMPONENT EXISTS. Every `<figure>` in this kit draws its numbers with
 * `aria-hidden` CSS bars and publishes the same numbers as a real `<table>` for
 * anyone reading with assistive tech — an aria-label listing twenty parties and
 * twenty amounts is one unnavigable sentence, whereas a table can be read row by
 * row. That part was right. Putting Tailwind's `.sr-only` ON THE TABLE was not.
 *
 * `.sr-only` is `position:absolute; width:1px; height:1px; overflow:hidden;
 * clip:rect(0,0,0,0)`. On a normal block that clips. On a `display:table` box it
 * does NOT: CSS `width` on a table is a MINIMUM, not a cap, so the table lays
 * out at its full content width, and because it is absolutely positioned that
 * width joins the document's scroll width. Measured on 2026-08-02 at a 375 px
 * viewport: `/politicians/donations` shipped sr-only tables 1680 px, 1661 px and
 * 993 px wide and the document scrolled to 1727 px — **+1352 px of horizontal
 * overflow, and +1428 px even at 768 px**. `/politicians/changes` (+479 px) and
 * `/politicians/compare` (+354 px) had the same fault from the same cause.
 *
 * For a reader that is a page which rubber-bands sideways into a screen-and-a-
 * half of blank space, dragging the sticky header with it. Nothing looks broken
 * at scroll-left 0, which is exactly why it survived this long.
 *
 * THE FIX IS THE WRAPPER, NOT THE TABLE. `.sr-only` moves onto a plain `<div>`,
 * which is a block box and therefore really is 1 px wide with `overflow:hidden`.
 * The table inside keeps `display:table` and every bit of its semantics — the
 * screen-reader experience is byte-for-byte what it was — but its overflow is
 * clipped by an ancestor that cannot grow. One component, so all five politician
 * surfaces inherit the fix and no future chart can reintroduce it by hand.
 */

import type { ReactNode } from "react";

export interface ScreenReaderTableProps {
  /**
   * The table's accessible name. Optional only because some callers name the
   * table with a `<caption>` instead, which is equally good.
   */
  ariaLabel?: string;
  /** `<caption>`, `<thead>`, `<tbody>` — a normal table body. */
  children: ReactNode;
}

export function ScreenReaderTable({ ariaLabel, children }: ScreenReaderTableProps) {
  return (
    // The clip lives HERE. Never move `sr-only` onto the <table> below; see the
    // docblock — a 1px width does not constrain a display:table box.
    <div className="sr-only">
      <table aria-label={ariaLabel}>{children}</table>
    </div>
  );
}
