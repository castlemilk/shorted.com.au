"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the nearby rail.
 *
 * The rail calls a connect-web client action, and importing connect-web anywhere
 * on the SSR path throws "Element type is invalid" (see CLAUDE.md). "use client"
 * alone is not enough — a client component is still server-rendered — so the
 * ssr:false boundary has to be here, around this one rail, rather than around the
 * whole profile as it used to be.
 *
 * No skeleton: the rail renders nothing until it has data anyway, so a
 * placeholder would only reserve space for a card that may never appear.
 */
export const SuburbNearbyRail = dynamic(
  () => import("./suburb-nearby-rail").then((m) => m.SuburbNearbyRail),
  { ssr: false },
);
