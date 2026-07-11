import { cn } from "~/@/lib/utils";
import { StockLogoImg } from "./stock-logo-img";

/**
 * Small company logo chip for dense report tables and card logo clusters.
 *
 * Server-renderable by design (no "use client"): the deterministic
 * letter-avatar is layered BEHIND the <img>, so when `logoUrl` is empty
 * (old reports without hydrated logos) the avatar shows without any
 * client-side error handling. The <img> itself is a tiny client leaf
 * (StockLogoImg) that removes itself on load error so dead logo URLs fall
 * back to the avatar instead of a broken-image glyph.
 */

const SIZES = {
  sm: 20,
  md: 28,
} as const;

export type StockLogoSize = keyof typeof SIZES;

/**
 * Deterministic hue (0-359) from a stock code so a given company's
 * fallback avatar is always the same colour, everywhere.
 */
export function hueFromCode(code: string): number {
  const normalized = code.toUpperCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) % 360;
  }
  return hash;
}

interface StockLogoProps {
  code: string;
  logoUrl?: string;
  size?: StockLogoSize;
  className?: string;
}

export function StockLogo({
  code,
  logoUrl,
  size = "md",
  className,
}: StockLogoProps) {
  const px = SIZES[size];
  const hue = hueFromCode(code);
  const initials = code.slice(0, 2).toUpperCase();

  return (
    <span
      aria-hidden="true"
      data-testid="stock-logo"
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-md ring-1 ring-border/70",
        className,
      )}
      style={{ width: px, height: px }}
    >
      {/* Letter avatar — sits behind the logo image as the fallback layer. */}
      <span
        data-testid="stock-logo-fallback"
        className="absolute inset-0 flex items-center justify-center font-semibold leading-none text-white/95"
        style={{
          backgroundColor: `hsl(${hue}, 38%, 38%)`,
          fontSize: Math.round(px * 0.38),
          letterSpacing: "0.02em",
        }}
      >
        {initials}
      </span>
      {logoUrl ? <StockLogoImg src={logoUrl} px={px} /> : null}
    </span>
  );
}
