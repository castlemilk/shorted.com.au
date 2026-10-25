"use client";

import { useEffect, useState } from "react";
import { createPortalSession, getSubscriptionStatus } from "~/app/actions/subscription";

/**
 * Tells a customer whose last payment failed, and links them to the Stripe billing
 * portal to update the card. Shown only for past_due. Whether access continues
 * is read from the same entitlement the rest of the app uses, so the words match
 * what the customer actually has.
 *
 * Loaded client-only from the root layout (ssr: false), like the chat sidebar, so
 * the Connect-RPC imports stay out of the server render.
 */
export function PastDueBanner() {
  const [state, setState] = useState<{ entitled: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSubscriptionStatus()
      .then((info) => {
        if (!cancelled && info.status === "past_due") {
          setState({ entitled: info.hasActiveSubscription });
        }
      })
      .catch(() => {
        // Best effort. A banner that cannot load must not break the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

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
