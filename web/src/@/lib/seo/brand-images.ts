import { siteConfig } from "~/@/config/site";

/**
 * The brand images structured data names as the site's own, so a search
 * engine choosing a thumbnail for a page has a stated candidate. Without one,
 * Google read the homepage's only `image` property, the founder's headshot
 * on the Organization's nested Person, and showed it beside the homepage
 * result (observed 2026-11-07). The Person keeps no `image` there now; the
 * photo stays on /about and the author page, which are about him.
 */
export const brandLogoImageObject = {
  "@type": "ImageObject",
  url: siteConfig.logo.url,
  width: siteConfig.logo.width,
  height: siteConfig.logo.height,
  caption: `${siteConfig.name} logo`,
} as const;

/** The 1200x630 card `app/opengraph-image.tsx` draws. */
export const brandCardImageObject = {
  "@type": "ImageObject",
  url: siteConfig.ogImage,
  width: 1200,
  height: 630,
  caption: `${siteConfig.name}: official ASIC short position data for ASX stocks`,
} as const;

/** Logo first: the square mark reads best at thumbnail size. */
export const brandImages = [brandLogoImageObject, brandCardImageObject] as const;
