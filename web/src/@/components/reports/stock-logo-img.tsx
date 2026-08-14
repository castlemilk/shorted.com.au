"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Client leaf for StockLogo: the logo image that removes itself when the URL
 * 404s, letting the server-rendered letter avatar behind it show through.
 * Kept as a tiny separate "use client" module so StockLogo itself stays a
 * server component.
 *
 * Serving strategy:
 * - Known bucket hosts go through next/image → resized AVIF/WebP at the chip
 *   size (~1KB for a 20-28px chip vs ~7KB raw icon PNG), cached by the Vercel
 *   image cache + browser (the GCS icons send Cache-Control max-age=86400).
 * - SVGs and unknown hosts render as a plain <img>: next/image THROWS at
 *   render for un-allowlisted hosts and rejects SVG without
 *   dangerouslyAllowSVG, so both degrade to "unoptimized", never a crash.
 */

const OPTIMIZED_HOSTS = new Set([
  "storage.googleapis.com",
  "lh3.googleusercontent.com",
  "shorted.com.au",
]);

function canOptimize(src: string): boolean {
  try {
    const url = new URL(src);
    if (!OPTIMIZED_HOSTS.has(url.hostname)) return false;
    return !url.pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

export function StockLogoImg({ src, px }: { src: string; px: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  const className =
    "absolute inset-0 h-full w-full bg-white object-contain p-[2px]";

  if (canOptimize(src)) {
    return (
      <Image
        src={src}
        alt=""
        width={px}
        height={px}
        sizes={`${px}px`}
        quality={75}
        loading="lazy"
        onError={() => setFailed(true)}
        className={className}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
