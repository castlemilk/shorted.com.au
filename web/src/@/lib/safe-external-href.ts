/**
 * Hrefs for URLs that come from data.
 *
 * Company websites and social links, news and announcement links, filing,
 * listing, register and citation URLs are scraped, model-written or typed by
 * users, and React 18 renders whatever string it is handed as an href,
 * `javascript:` included. A `javascript:` link runs in our origin when it is
 * followed, and `data:` and `vbscript:` links are no better (security review
 * SEC-07: the scraped company `links` already hold 135 `javascript:` URLs).
 *
 * Where these return undefined, render the text without a link, or leave the
 * link out as the component does for a missing URL.
 */

/** "http://" or "https://" at the very start, in any case. */
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/**
 * The URL, trimmed, when it is an absolute http: or https: URL with a host;
 * otherwise undefined.
 *
 * The scheme is whatever precedes the first ":", so testing for "http://" at
 * the start of the trimmed value leaves nothing that could change it: a
 * `javascript:`, `data:` or `vbscript:` URL fails, and so does one whose
 * scheme sits behind a control character or is split by a tab, which a
 * browser would strip and then run. A protocol-relative `//host` and a
 * relative path fail too. The URL parser then rejects what is not a URL at
 * all ("https://", a space in the host).
 */
export function safeExternalHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (!ABSOLUTE_HTTP_URL.test(href)) return undefined;
  try {
    return new URL(href).host ? href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * As safeExternalHref, but a link inside our own pages is kept too: a
 * fragment ("#ref-1") or a root-relative path ("/shorts/BHP"). A path that a
 * browser would read as protocol-relative ("//host", "/\host", or either with
 * a tab or newline in between, which the URL parser drops) is not one.
 *
 * For links written into stored prose (a take's markdown), which point at our
 * own pages as often as at a source.
 */
export function safeLinkHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (href.startsWith("#")) return href;
  if (href.startsWith("/")) {
    return /^\/[/\\]/.test(href.replace(/[\t\n\r]/g, "")) ? undefined : href;
  }
  return safeExternalHref(href);
}
