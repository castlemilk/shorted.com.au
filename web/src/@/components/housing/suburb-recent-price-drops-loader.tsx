"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the suburb's recent price drops.
 *
 * Same reason as the nearby rail: it calls a connect-web client action, and
 * connect-web on the SSR path throws "Element type is invalid" (see CLAUDE.md).
 * The ssr:false boundary is scoped to this card so the rest of the profile stays
 * in the server HTML.
 *
 * No skeleton: the card renders nothing when the listing tier is disabled or
 * empty, so a placeholder would promise content that often does not exist.
 */
export const RecentPriceDrops = dynamic(
  () => import("./suburb-recent-price-drops").then((m) => m.RecentPriceDrops),
  { ssr: false },
);
