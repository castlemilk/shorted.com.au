"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { createPortalSession, getSubscriptionStatus } from "~/app/actions/subscription";
import { isChromelessRoute } from "~/@/lib/chromeless-routes";

/**
 * Tells a customer whose last payment failed, and links them to the Stripe billing
 * portal to update the card. Shown only for past_due, and only on a page that shows
 * chrome (see chromeless-routes.ts). The wording follows whether access continues, so
 * the banner says what the customer actually has.
 *
 * It costs nothing for a visitor who is signed out or on a chrome-less route: it makes
 * no request. For a signed-in customer it makes one status request, and keeps the
 * answer for a few minutes in sessionStorage, so the next page view does not repeat
 * it. The cache is per browser tab, and it is only a convenience: if storage is
 * unavailable the banner simply asks again.
 *
 * Loaded client-only from the root layout (ssr: false), like the chat sidebar, so
 * the Connect-RPC imports stay out of the server render.
 */

const CACHE_KEY = "shorted:past-due-banner:v1";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedAnswer {
  userId: string;
  at: number;
  pastDue: boolean;
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

export function PastDueBanner() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const userId = status === "authenticated" ? (session?.user?.id ?? null) : null;
  const [state, setState] = useState<{ entitled: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chromeless = isChromelessRoute(pathname ?? "");

  useEffect(() => {
    if (chromeless || !userId) return;

    const cached = readCache(userId);
    if (cached) {
      setState(cached.pastDue ? { entitled: cached.entitled } : null);
      return;
    }

    let cancelled = false;
    getSubscriptionStatus()
      .then((info) => {
        if (cancelled) return;
        const pastDue = info.status === "past_due";
        writeCache({ userId, at: Date.now(), pastDue, entitled: info.hasActiveSubscription });
        setState(pastDue ? { entitled: info.hasActiveSubscription } : null);
      })
      .catch(() => {
        // Best effort. A banner that cannot load must not break the page.
      });
    return () => {
      cancelled = true;
    };
  }, [chromeless, userId]);

  if (chromeless || !state) return null;

  async function openPortal() {
    setOpening(true);
    setError(null);
    const result = await createPortalSession();
    if (result.url) {
      window.location.href = result.url;
      return;
    }
    setOpening(false);
    setError("We couldn't open the billing page. Try again in a moment.");
  }

  return (
    <div
      role="alert"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {state.entitled
            ? "Your last payment didn't go through. Your access continues while Stripe retries the card."
            : "Your last payment didn't go through, so your paid access has ended. Update your card to restore it."}
        </p>
        <div className="flex items-center gap-3">
          {error ? <span className="text-destructive">{error}</span> : null}
          <button
            type="button"
            onClick={() => void openPortal()}
            disabled={opening}
            className="font-medium underline underline-offset-4 disabled:opacity-60"
          >
            {opening ? "Opening billing…" : "Update your card"}
          </button>
        </div>
      </div>
    </div>
  );
}
