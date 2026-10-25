/**
 * Routes that render without the site's chrome (header, footer and any banner that
 * sits above the page). Each one is a page whose own layout must own the whole
 * viewport: an embedded chart or widget, a shared chart page, or an OAuth consent
 * screen, where a nav bar beside the decision invites a wander-off mid-authorisation.
 *
 * The header and every banner read this one list, so a banner can never appear on a
 * page the header leaves bare.
 */
export function isChromelessRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/embed") ||
    pathname.startsWith("/chart/") ||
    pathname.startsWith("/oauth/")
  );
}
