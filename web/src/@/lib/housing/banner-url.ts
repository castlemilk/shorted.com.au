/**
 * Gate for the suburb banner's bespoke background override.
 *
 * `GetSuburbProfileResponse.banner.bg_url` is a free-text string that comes back
 * from the RPC and was being rendered straight into an `<img src>`. That makes
 * whatever writes that column — a job, a migration, an operator console — able
 * to point every visitor's browser at an arbitrary third-party host: a tracking
 * pixel by another name, an outbound request carrying the visitor's IP and
 * Referer, and an uncapped payload on the page's largest asset.
 *
 * So the override is opt-in by host. Anything unrecognised falls back to the
 * baked archetype art, which is always present — the page never breaks, it just
 * declines the override.
 */

/**
 * Hosts we are willing to load banner art from. `storage.googleapis.com` is our
 * own GCS bucket and is already in next.config.mjs's image `remotePatterns`;
 * add here and there together.
 */
export const ALLOWED_BANNER_HOSTS: ReadonlySet<string> = new Set([
  "storage.googleapis.com",
]);

/**
 * Returns the URL if it is safe to render, else null.
 *
 * Root-relative paths are ours by definition and always pass. Everything else
 * must be https on an allowlisted host — which rejects protocol-relative
 * (`//evil.example`), plain http, and any `data:`/`javascript:` scheme.
 */
export function safeBannerUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  // Our own asset. `//host` is protocol-relative, NOT a path — reject it.
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_BANNER_HOSTS.has(url.hostname)) return null;
  return url.toString();
}
