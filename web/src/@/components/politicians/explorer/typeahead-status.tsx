/**
 * The line inside a member typeahead's listbox that says what is happening.
 *
 * WHY. Measured on 2026-08-02 against a production build: the `/changes` member
 * typeahead took 657 ms median for "alba" (~420 ms of it after the last
 * keystroke) and `/compare` took 1,192 ms for "dutton" (~830 ms after the last
 * keystroke). A busy affordance appeared in **0 of 5 runs on both**. For that
 * whole second the reader has typed a name and the widget shows either nothing
 * or the previous query's people — which reads as "no results" or, worse, as
 * results.
 *
 * The latency is not ours to delete. `/api/algolia/search` is a flat 205 ms
 * through the Next rewrite AND straight at the Go proxy, so it is the wire; the
 * debounces (160/180 ms) are already at the useful limit and shortening them
 * buys requests, not speed. What was missing was an answer to "did it hear me",
 * and that is what this renders.
 *
 * THE RULES IT FOLLOWS.
 *   - `role="presentation"`, so it is NOT offered as an option a screen reader
 *     can choose. A status line inside a listbox that claims to be an option is
 *     a dead end for keyboard and AT users alike.
 *   - `aria-live="polite"` on a wrapper that is always mounted. A live region
 *     inserted at the same moment its text appears is not reliably announced —
 *     the region has to exist first for the change to be a change.
 *   - TEXT, NOT COLOUR, AND NEVER A BARE SPINNER. House rule: no state is
 *     signalled by colour alone. The word "Searching…" is the affordance; the
 *     pulsing dot beside it is decoration and is `aria-hidden`.
 *   - PREVIOUS RESULTS STAY ON SCREEN while this shows. Blanking the list on
 *     every keystroke is the flicker that made the wait feel longer than it is;
 *     the callers keep their hits and render this above them.
 */

export interface TypeaheadStatusProps {
  /** True from the keystroke until the lookup answers — debounce included. */
  searching: boolean;
  /**
   * What is being searched, for the announcement ("members"). Read aloud, so it
   * is a plain plural noun and not a UI label.
   */
  subject?: string;
}

export function TypeaheadStatus({ searching, subject = "members" }: TypeaheadStatusProps) {
  return (
    // Always mounted, always live: see the docblock. When idle it announces
    // nothing because it contains nothing.
    <li
      role="presentation"
      aria-live="polite"
      className={searching ? "px-2 py-1.5" : "sr-only"}
    >
      {searching ? (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          />
          Searching {subject}…
        </span>
      ) : null}
    </li>
  );
}
