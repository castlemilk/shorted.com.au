import type { Metadata } from "next";
import { Suspense } from "react";

import { RateLimitPageClient } from "./rate-limit-page-client";

export const metadata: Metadata = {
  title: "Request limit reached",
  description:
    "You've reached a request limit on Shorted. Here's what happened, when it resets, and how to get higher limits.",
  // Never index: this is a transient utility surface, and indexing it would put
  // an error page in the results for brand queries.
  robots: { index: false, follow: false },
};

/**
 * Standalone rate-limit page.
 *
 * Deep-linkable so the API, the edge worker, or an email can point a caller at
 * a real explanation instead of a bare 429 body. In-app rate limits do NOT
 * redirect here — a browsing user gets an inline notice on the widget that
 * failed (see RateLimitNotice `inline`).
 */
export default function RateLimitPage() {
  return (
    // Real Suspense boundary: RateLimitPageClient calls useSearchParams, which
    // requires one, and having it here keeps the route statically rendered.
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <RateLimitPageClient />
    </Suspense>
  );
}
