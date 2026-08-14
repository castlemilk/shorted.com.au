"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Directory logo tile.
 *
 * - Fixed 56x40 (7:5) white tile: company logos are a mix of square icons and
 *   wide wordmarks — a square tile crushed wordmarks into illegible slivers.
 *   The wider tile with flex centering keeps both shapes legible and centered.
 * - Graceful failure: some `logo_url`s 404 on GCS; a server-rendered <Image>
 *   would show the browser's broken-image icon, so swap to a ticker-initials
 *   tile on error instead.
 */
export function CompanyLogo({ src, code }: { src: string | null; code: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="flex h-10 w-14 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold text-muted-foreground ring-1 ring-border"
      >
        {code.slice(0, 3)}
      </span>
    );
  }

  // SVG logos (the enrichment pipeline stores some as logos/svg/CODE.svg)
  // can't go through the image optimizer without dangerouslyAllowSVG — serve
  // them as-is; they're tiny and come from our own bucket.
  const isSvg = src.split("?")[0]?.toLowerCase().endsWith(".svg");

  // Cache-bust: bump when bucket logo files are edited in place (v2 =
  // 2026-07-20 whitespace-trim batch) so the Vercel image cache and browsers
  // re-fetch instead of serving day-old transforms of the old files.
  const versioned = `${src}${src.includes("?") ? "&" : "?"}v=2`;

  return (
    <span
      aria-hidden
      className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-1 ring-1 ring-border"
    >
      <Image
        src={versioned}
        alt=""
        width={96}
        height={72}
        sizes="48px"
        unoptimized={isSvg}
        // h/w-full + object-contain (not max-*): small source images must
        // scale UP to fill the tile too, or a 30px mark renders as a speck.
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
