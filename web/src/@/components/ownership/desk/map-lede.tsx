"use client";

/**
 * The Market map's lede (spec 14.3): it names the lens the reader is looking through,
 * so the words and the Source control agree. The lens is in the link (`?lens=index`),
 * which the map island writes; the server's first paint is the notices lede.
 */

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { lede } from "@/lib/typography";

export const NOTICES_LEDE = "See what the notices disclose";
export const INDEX_LEDE = "See where tracked index funds hold company shares";

/** The lede for a lens: the index fund files, or the notices (the default). */
export function mapLede(lens: string | null): string {
  return lens === "index" ? INDEX_LEDE : NOTICES_LEDE;
}

function LiveMapLede() {
  const searchParams = useSearchParams();
  return <p className={lede}>{mapLede(searchParams?.get("lens") ?? null)}</p>;
}

export function MapLede() {
  return (
    <Suspense fallback={<p className={lede}>{NOTICES_LEDE}</p>}>
      <LiveMapLede />
    </Suspense>
  );
}
