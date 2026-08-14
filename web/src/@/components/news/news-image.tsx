import Image from "next/image";

// Publisher CDNs we've allowlisted in next.config.mjs `images.remotePatterns`.
// ONLY these hosts can be routed through Next's /_next/image optimizer
// (resized AVIF/WebP) — an un-allowlisted host throws at render time, so the
// component falls back to a plain <img> for anything not in this set.
//
// KEEP IN SYNC with the "News publisher CDNs" block in web/next.config.mjs.
const OPTIMIZED_HOSTS = new Set<string>([
  "stockhead.com.au",
  "www.stockhead.com.au",
  "smallcaps.com.au",
  "www.smallcaps.com.au",
  "fool.com.au",
  "www.fool.com.au",
  "kalkinemedia.com",
  "www.kalkinemedia.com",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

interface NewsImageProps {
  /** Absolute URL of the external thumbnail. */
  src: string;
  /** Alt text. "" is valid when the image is decorative and the wrapping
   *  link carries the accessible name (aria-label). */
  alt?: string;
  /** Responsive `sizes` hint — REQUIRED so next/image requests a right-sized
   *  variant instead of the full-width source. */
  sizes: string;
  className?: string;
  /** Above-the-fold hero image → skip lazy-loading. */
  priority?: boolean;
}

/**
 * External news thumbnail with graceful optimization.
 *
 * Allowlisted publisher hosts are served through next/image — a ~550KB
 * publisher JPEG becomes a right-sized ~30-60KB AVIF/WebP from /_next/image,
 * which is the single biggest LCP/image-delivery win on /news and the
 * homepage news grid. Any other host renders a plain, still-responsive <img>
 * so an unexpected source degrades to "unoptimized" rather than crashing.
 *
 * The parent MUST be a positioned, sized box (e.g. `relative aspect-[16/9]`)
 * because we render with `fill`.
 */
export function NewsImage({
  src,
  alt = "",
  sizes,
  className,
  priority = false,
}: NewsImageProps) {
  const host = hostOf(src);
  const canOptimize = host !== null && OPTIMIZED_HOSTS.has(host);

  if (canOptimize) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        className={className}
        priority={priority}
        // Publisher thumbnails are already lightly compressed; 65 keeps them
        // crisp at card size while shrinking the payload hard.
        quality={65}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      sizes={sizes}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      className={className}
    />
  );
}
