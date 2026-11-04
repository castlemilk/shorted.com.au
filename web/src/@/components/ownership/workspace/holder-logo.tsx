"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { kindInfo } from "~/@/lib/ownership/kinds";
import { StockLogoBox } from "./stock-logo-box";

/**
 * The host of a registry website, or null when it is not a web address. Only the
 * host leaves the page, in the favicon request: the path and query never do.
 */
export function holderHost(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}

/** The favicon endpoint for a host (spec 14.2). */
export function holderFaviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
}

/** A listed holder's key (`asx:CODE`, spec 14.2): its company's logo, not a favicon. */
const LISTED_HOLDER_KEY = /^asx:([A-Z0-9]{1,6})$/;

/**
 * Up to two letters for a monogram: the first letter of the first two words, or
 * the first two letters of a single word. Never empty for a non-blank name.
 */
export function holderMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

const DARK_INK = "text-[#1A120E]";
const LIGHT_INK = "text-white";

/**
 * The monogram's ink for each kind, as literal classes (Tailwind reads them whole).
 * Every swatch in kinds.ts is light enough for the dark ink except the three
 * below: bank and broker is dark in both themes, and corporate and private equity
 * are dark in light mode and light in dark mode, so each takes the ink that reads
 * on its own swatch. `monogramInkClass` is tested against the swatches for 4.5:1.
 */
const MONOGRAM_INK: Readonly<Record<string, string>> = {
  bank_broker: LIGHT_INK,
  corporate: "text-white dark:text-[#1A120E]",
  private_equity: "text-white dark:text-[#1A120E]",
};

/** The text colour a kind's monogram is drawn in. */
export function monogramInkClass(kind: string): string {
  return MONOGRAM_INK[kind] ?? DARK_INK;
}

const frameBase =
  "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius)]";

/**
 * A holder's site icon or logo (spec 14.2), in a box of fixed size. A listed
 * holder (`asx:CODE`) gets the company's logo; a registry holder gets its favicon
 * from its website; a `name:` holder, or one with no website, gets the monogram.
 * A failed image falls back to the monogram in the same box, so nothing moves.
 */
export function HolderLogo({
  name,
  kind,
  website,
  holderKey,
  size = 20,
  className,
}: {
  name: string;
  kind: string;
  website?: string | null;
  /** The holder's key: a registry slug, `asx:CODE` or `name:...`. */
  holderKey?: string | null;
  size?: 20 | 28;
  className?: string;
}) {
  const listed = holderKey ? LISTED_HOLDER_KEY.exec(holderKey)?.[1] ?? null : null;
  if (listed !== null) {
    return (
      <StockLogoBox
        code={listed}
        size={size}
        className={cn(frameBase, className)}
        fallback={<Monogram name={name} kind={kind} size={size} className={className} />}
      />
    );
  }
  // A holder off the registry (`name:...`) is a monogram only, never a favicon.
  const host = holderKey?.startsWith("name:") ? null : holderHost(website);
  if (host === null) return <Monogram name={name} kind={kind} size={size} className={className} />;
  return <FaviconLogo host={host} name={name} kind={kind} size={size} className={className} />;
}

function FaviconLogo({
  host,
  name,
  kind,
  size,
  className,
}: {
  host: string;
  name: string;
  kind: string;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Monogram name={name} kind={kind} size={size} className={className} />;
  return (
    <span className={cn(frameBase, className)} style={{ width: size, height: size }} data-holder-logo="favicon">
      {/* A favicon from Google's endpoint, not a page asset; no referrer leaves. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={holderFaviconUrl(host)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        decoding="async"
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function Monogram({
  name,
  kind,
  size,
  className,
}: {
  name: string;
  kind: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        frameBase,
        kindInfo(kind).swatch,
        monogramInkClass(kind),
        "font-mono text-[10px] font-semibold",
        className,
      )}
      style={{ width: size, height: size }}
      data-holder-logo="monogram"
    >
      {holderMonogram(name)}
    </span>
  );
}
