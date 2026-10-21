import { safeExternalHref } from "~/@/lib/safe-external-href";

/**
 * The hosts an OG image route may fetch a stored image from. Company logos
 * (company-metadata.logo_gcs_url) and take images (the take-writer's uploads)
 * all live in Cloud Storage, the host next.config.mjs allows for images.
 */
const IMAGE_HOSTS: ReadonlySet<string> = new Set(["storage.googleapis.com"]);

/**
 * The URL when an OG route may fetch it from our servers, otherwise
 * undefined.
 *
 * The URL is stored, and company-metadata is writable with the anon key today
 * (security review SEC-07), so a fetch of whatever the row holds would let a
 * row point our server at any address. Only https on an allowed host, on the
 * default port and with no credentials, is fetched. Fetch it with
 * `redirect: "error"` so a redirect cannot leave the host either.
 */
export function ogImageFetchUrl(value: string | null | undefined): string | undefined {
  const href = safeExternalHref(value);
  if (!href) return undefined;
  const url = new URL(href);
  if (
    url.protocol !== "https:" ||
    !IMAGE_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  return url.href;
}
