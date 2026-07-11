"use client";

import { useState } from "react";

/**
 * Client leaf for StockLogo: a plain <img> that removes itself when the URL
 * 404s, letting the server-rendered letter avatar behind it show through.
 * Kept as a tiny separate "use client" module so StockLogo itself stays a
 * server component (plain <img>, NOT next/image — logo URLs can point at
 * unlisted hosts and next/image throws on those).
 */
export function StockLogoImg({ src, px }: { src: string; px: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
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
      className="absolute inset-0 h-full w-full bg-white object-contain p-[2px]"
    />
  );
}
