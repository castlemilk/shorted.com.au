"use client";

import { type ReactNode } from "react";
import { useSession } from "next-auth/react";

// Client-side session gate for ISR pages.
//
// The stock page used to read auth() server-side, which forces dynamic
// rendering (cookies) and blocked the force-dynamic -> ISR conversion.
//
// IMPORTANT: children travel in the shared RSC payload regardless of
// session — only gate PROMOTIONAL/neutral UI (sign-in prompts) with this.
// Authenticated-only DATA must be fetched client-side after the session
// resolves (see StockEvidencePanelClient), never rendered server-side into
// a cached page.

/** Renders children only once the session has resolved as signed-out. */
export function SignedOutOnly({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status !== "unauthenticated") return null;
  return <>{children}</>;
}
