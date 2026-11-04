"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { normalizedLogoUrl, rawLogoUrl } from "@/lib/logo";

/**
 * A stock's logo in a box of fixed size (spec 14.2): the normalised logo, then
 * the raw one, then nothing. A logo that fails leaves the box empty, never a
 * placeholder glyph, so a dense cell or row keeps its shape. The box is reserved
 * before the image loads, so nothing moves when it arrives.
 *
 * `fallback` is drawn in the same box once both logos have failed. Only a caller
 * that has a better stand-in than an empty box passes one (a holder's monogram).
 */
export function StockLogoBox({
  code,
  size,
  className,
  fallback = null,
}: {
  code: string;
  size: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const [stage, setStage] = useState<"normalized" | "raw" | "none">("normalized");
  const src =
    stage === "normalized"
      ? normalizedLogoUrl(code)
      : stage === "raw"
        ? rawLogoUrl(code)
        : null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        className,
      )}
      style={{ width: size, height: size }}
      data-stock-logo={stage}
    >
      {src !== null ? (
        // The logo is a bucket image of a known URL; next/image would need a
        // loader for it and would reserve nothing extra.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
          onError={() => setStage(stage === "normalized" ? "raw" : "none")}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
