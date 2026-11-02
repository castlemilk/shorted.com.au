/**
 * The screen a chart is offered landscape mode on: a phone held upright, the
 * same query as Tailwind's `max-sm:portrait`. Pure, and no React, so a state
 * initializer can read it on the first render.
 */
export const PORTRAIT_PHONE_QUERY =
  "(max-width: 639.98px) and (orientation: portrait)";

/**
 * Whether the screen is a portrait phone right now. False where there is no
 * window or no matchMedia (the server, and an old browser).
 */
export function isPortraitPhone(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia(PORTRAIT_PHONE_QUERY).matches;
}
