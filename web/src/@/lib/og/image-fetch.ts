import { siteConfig } from "~/@/config/site";
import { safeLinkHref } from "~/@/lib/safe-external-href";

/**
 * The hosts an OG image route may fetch a stored image from, any path on them.
 * Company logos (company-metadata.logo_gcs_url) and the take-writer's uploads
 * live in Cloud Storage, the host next.config.mjs allows for images.
 */
const IMAGE_HOSTS: ReadonlySet<string> = new Set(["storage.googleapis.com"]);

/**
 * Our own site, which a root-relative URL resolves against. Only its static
 * files under /assets/ are fetched: a take imported from content/news
 * (scripts/take-writer/src/import-mdx.ts stores the frontmatter as written)
 * keeps its OG and hero art in web/public/assets, absolute or root-relative.
 */
const SITE = new URL(siteConfig.url);

/**
 * A file under /assets/: plain names only, so no percent-encoding and no empty
 * or dot-led segment. next.config.mjs sets only a header there and no route
 * lives under it, so the path names a file in web/public/assets and nothing
 * else on our host.
 */
const SITE_ASSET_PATH = /^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The absolute URL when an OG route may fetch it from our servers, otherwise
 * undefined.
 *
 * The URL is stored data, scraped or written by a model (security review
 * SEC-07), so a fetch of whatever the row holds would let a bad row point our
 * server at any address. Only https on the default port and with
 * no credentials is fetched: anywhere on an allowed host, or a static file
 * under /assets/ on our own. A root-relative path is our own host; a
 * protocol-relative one is refused (safeLinkHref). Fetch it with
 * `redirect: "error"` so a redirect cannot leave the host either.
 */
export function ogImageFetchUrl(value: string | null | undefined): string | undefined {
  const href = safeLinkHref(value);
  if (!href || href.startsWith("#")) return undefined;
  let url: URL;
  try {
    url = new URL(href, SITE);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return undefined;
  }
  if (url.hostname === SITE.hostname) {
    return SITE_ASSET_PATH.test(url.pathname) ? url.href : undefined;
  }
  return IMAGE_HOSTS.has(url.hostname) ? url.href : undefined;
}
