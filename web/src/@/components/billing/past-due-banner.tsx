"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { isChromelessRoute } from "~/@/lib/chromeless-routes";

/**
 * Tells a customer whose card was declined that they need to update it, and links to
 * /billing/portal. That route runs in the browser's own session, so it opens the
 * Stripe billing portal for the signed-in customer. A server-side call would carry no
 * cookie and could not do that.
 *
 * Shown for past_due (access continues while Stripe retries, or has ended past the
 * grace) and for unpaid (Stripe has stopped retrying, and access is paused). Only on a
 * page that shows chrome (see chromeless-routes.ts). It makes no request for a visitor
 * who is signed out or on a chrome-less route. For a signed-in customer it makes one
 * status request and keeps the answer per tab for five minutes in sessionStorage. The
 * cache is a convenience only: if storage is unavailable the banner asks again.
 *
 * Loaded client-only from the root layout (ssr: false), like the chat sidebar.
 */

const CACHE_KEY = "shorted:billing-banner:v2";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedAnswer {
  userId: string;
  at: number;
  status: string;
  entitled: boolean;
}

function readCache(userId: string): CachedAnswer | null {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedAnswer;
    if (cached.userId !== userId) return null;
    if (Date.now() - cached.at > CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(answer: CachedAnswer): void {
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(answer));
  } catch {
    // Storage blocked or full: the next page view just asks again.
  }
}

/** The banner's copy for a status, or null when the status needs no banner. */
export function bannerFor(status: string, entitled: boolean): { text: string } | null {
  if (status === "unpaid") {
    return { text: "Your access is paused until you update your card." };
  }
  if (status === "past_due") {
    return {
      text: entitled
        ? "Your last payment didn't go through. Your access continues while Stripe retries the card."
        : "Your last payment didn't go through, so your paid access has ended. Update your card to restore it.",
    };
  }
  return null;
}

export function PastDueBanner() {
  const pathname = usePathname();
  const { data: session, status: sessionStatus } = useSession();
  const userId = sessionStatus === "authenticated" ? (session?.user?.id ?? null) : null;
  const [banner, setBanner] = useState<{ text: string } | null>(null);
  const chromeless = isChromelessRoute(pathname ?? "");

  useEffect(() => {
    if (chromeless || !userId) return;

    const cached = readCache(userId);
    if (cached) {
      setBanner(bannerFor(cached.status, cached.entitled));
      return;
    }

    let cancelled = false;
    getSubscriptionStatus()
      .then((info) => {
        if (cancelled) return;
        writeCache({ userId, at: Date.now(), status: info.status, entitled: info.hasActiveSubscription });
        setBanner(bannerFor(info.status, info.hasActiveSubscription));
      })
      .catch(() => {
        // Best effort. A banner that cannot load must not break the page.
      });
    return () => {
      cancelled = true;
    };
  }, [chromeless, userId]);

  if (chromeless || !banner) return null;

  return (
    <div
      role="alert"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>{banner.text}</p>
        <a
          href="/billing/portal"
          className="font-medium underline underline-offset-4"
        >
          Update your card
        </a>
      </div>
    </div>
  );
}
