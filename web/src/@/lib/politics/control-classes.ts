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
 * ONE FOCUS TREATMENT FOR EVERY CONTROL IN THE FEATURE.
 *
 * The selects had a ring and the buttons beside them had nothing, so tabbing
 * across a filter bar showed a keyboard reader where they were on two controls
 * out of six and then lost them. `focus-visible` rather than `focus` so the ring
 * appears for the keyboard and not on every mouse click.
 */
export const POLITICS_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/**
 * A filter `<select>`: 44 px tall where a finger is the pointer, back to the
 * dense 32 px from `sm:` up where a mouse is.
 */
export const POLITICS_SELECT_CLASS =
  "h-11 sm:h-8 w-full sm:w-auto min-w-0 rounded-md border border-input bg-background px-2 text-xs " +
  POLITICS_FOCUS_RING;

/**
 * A bare text button sitting in a filter row ("Clear filters"), matched to the
 * selects beside it so the row's controls share one baseline and one hit area.
 */
export const POLITICS_FILTER_BUTTON_CLASS =
  "h-11 sm:h-8 rounded px-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground " +
  POLITICS_FOCUS_RING;

/**
 * A member typeahead `<input>`: the select's box, plus room for the magnifier.
 *
 * `pl-7` IS RESERVED SPACE, NOT PADDING TASTE. The icon is absolutely positioned
 * over the field, so without the inset the reader's own text runs underneath it.
 * Reserving the space in the class rather than at each call site is what keeps
 * the three search fields in this feature the same field.
 *
 * THE MAGNIFIER BELONGS HERE AND NOWHERE ELSE. The icon set's own config
 * constrains it to the search box, because a magnifying glass pointed at a
 * person reads as investigation — which is why the set carries no eye, no
 * binoculars and no detective at all. It may never appear beside a member's
 * name, in a heading about members, or on a profile.
 */
export const POLITICS_SEARCH_INPUT_CLASS =
  "h-11 sm:h-8 w-full min-w-0 rounded-md border border-input bg-background pl-7 pr-2 text-xs " +
  POLITICS_FOCUS_RING;

/**
 * A bordered pagination / toggle button. `min-h-11` rather than `h-11` so it can
 * still grow if its label wraps, and `sm:min-h-0` returns it to its natural
 * dense height on a pointer device.
 */
export const POLITICS_PAGER_BUTTON_CLASS =
  // transition-[…] names the properties: `transition-colors` and a scale can't
  // share an element (the later utility wins), and `transition-all` is banned.
  // The 0.98 press is the physical-push cue every enabled button here gets.
  "min-h-11 sm:min-h-0 rounded border px-3 py-1 transition-[background-color,color,transform] disabled:opacity-40 enabled:hover:bg-muted/50 enabled:hover:text-foreground enabled:active:scale-[0.98] " +
  POLITICS_FOCUS_RING;
