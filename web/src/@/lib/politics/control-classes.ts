/**
 * The filter-control classes every politician island shares.
 *
 * `w-full sm:w-auto min-w-0` IS PART OF THE FIX, NOT COSMETIC. A native
 * `<select>` sizes itself to its longest OPTION, not to its container — so the
 * "Party group" select on /donations (whose options are verbatim AEC party-group
 * keys) and the "Register category" select on the hub (whose options are the
 * register's own item wording) both grew wider than a 375 px viewport and ran
 * off the right edge with their borders off screen. `w-full` inside a capped
 * grid column makes the control take the column instead of dictating it, and
 * `sm:w-auto` restores the natural intrinsic width on a pointer device.
 *
 * WHY THEY LIVE HERE. Three islands (the hub register table, the activity
 * explorer and the donations explorer) had byte-identical copies of the same
 * `h-8 …` string. That is fine until a measurement says the height is wrong, at
 * which point three copies is three chances to fix two of them. Plain strings
 * only — no protobuf, no components — so the transitive client-boundary check
 * (`client-boundary.test.ts`) stays happy importing this from a `"use client"`
 * module.
 *
 * WHY 44 px ON TOUCH AND 32 px ON THE DESKTOP. Every filter `<select>` in this
 * feature was `h-8` — 32 px — against the WCAG 2.2 / platform target-size floor
 * of 44 px, and the measured audit found 447 of 481 interactive elements under
 * that floor on the hub alone. `h-11` is exactly 44 px.
 *
 * THE BREAKPOINT IS THE HEIGHT'S ONLY JOB. The type stays `text-xs` at every
 * width: the fix is a bigger TARGET, not bigger writing. Growing the font to
 * grow the box would reflow every filter bar it touches and undo the layout
 * work these same measurements paid for. Padding and height are free; type is
 * not.
 */

/**
 * A filter `<select>`: 44 px tall where a finger is the pointer, back to the
 * dense 32 px from `sm:` up where a mouse is.
 */
export const POLITICS_SELECT_CLASS =
  "h-11 sm:h-8 w-full sm:w-auto min-w-0 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * A bare text button sitting in a filter row ("Clear filters"), matched to the
 * selects beside it so the row's controls share one baseline and one hit area.
 */
export const POLITICS_FILTER_BUTTON_CLASS =
  "h-11 sm:h-8 px-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground";

/**
 * A bordered pagination / toggle button. `min-h-11` rather than `h-11` so it can
 * still grow if its label wraps, and `sm:min-h-0` returns it to its natural
 * dense height on a pointer device.
 */
export const POLITICS_PAGER_BUTTON_CLASS =
  "min-h-11 sm:min-h-0 rounded border px-3 py-1 disabled:opacity-40 enabled:hover:text-foreground";
