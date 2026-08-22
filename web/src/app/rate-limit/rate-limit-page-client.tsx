"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { RateLimitNotice } from "~/@/components/rate-limit/rate-limit-notice";
import { Button } from "~/@/components/ui/button";
import type {
  RateLimitInfo,
  RateLimitKind,
  RateLimitTier,
} from "~/@/lib/retry";

/**
 * Parse an optional non-negative integer query param.
 * Anything missing or malformed becomes `undefined`, and the notice degrades.
 */
function intParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function kindParam(value: string | null): RateLimitKind {
  const v = value?.trim().toLowerCase();
  if (v === "monthly") return "monthly";
  if (v === "per_minute" || v === "per-minute" || v === "minute") {
    return "per_minute";
  }
  return "unknown";
}

function tierParam(value: string | null): RateLimitTier | undefined {
  const v = value?.trim().toLowerCase();
  return v === "anonymous" || v === "free" || v === "paid" ? v : undefined;
}

/**
 * Standalone rate-limit surface.
 *
 * Query params are all optional context so this page can be deep-linked from an
 * API error body, an email, or the edge:
 *   /rate-limit?kind=monthly&reset=1756684800&tier=free&limit=2000&used=2000
 *
 * Read client-side via useSearchParams (under a Suspense boundary in page.tsx)
 * so the route stays statically rendered — reading searchParams in the server
 * component would force dynamic rendering for no benefit.
 */
export function RateLimitPageClient() {
  const params = useSearchParams();

  const kind = kindParam(params.get("kind"));
  const reset = intParam(params.get("reset"));
  const limit = intParam(params.get("limit"));
  const used = intParam(params.get("used"));
  const tier = tierParam(params.get("tier"));

  const info: RateLimitInfo = {
    isRateLimited: true,
    kind,
    tier,
    // `reset` maps to whichever window this page is describing.
    monthlyResetAt: kind === "monthly" ? reset : undefined,
    resetAt: kind === "monthly" ? undefined : reset,
    monthlyLimit: kind === "monthly" ? limit : undefined,
    monthlyUsed: kind === "monthly" ? used : undefined,
    limit: kind === "monthly" ? undefined : limit,
  };

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center px-4 py-12">
      <RateLimitNotice info={info} variant="page" tier={tier} />

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/">Back to dashboard</Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/docs/api">API documentation</Link>
        </Button>
      </div>
    </div>
  );
}
