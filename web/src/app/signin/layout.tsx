import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

/**
 * Sign-in is a utility route, not a content surface.
 *
 * Every locked module (see `intel-lock.tsx`) links here with a per-page
 * `?callbackUrl=`, so the route fans out into ~1,600 near-identical URLs —
 * one per stock page, plus housing/politician/economy variants. Left
 * indexable they burn crawl budget on the highest-volume cluster we actually
 * want indexed (`/shorts/[code]`), and they inherited the ROOT canonical, so
 * every one of them claimed `https://shorted.com.au` as its canonical URL.
 *
 * `noindex` is the signal that matters; the self-canonical just stops the
 * homepage claim. Do not add these paths to robots.txt `Disallow` — a
 * disallowed URL can never be crawled to see the `noindex`, which would
 * strand any variant Google has already indexed.
 */
export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to Shorted to unlock industry intelligence, alerts and saved watchlists for ASX short positions.",
  robots: { index: false, follow: false },
  alternates: { canonical: `${siteConfig.url}/signin` },
};

export default function SignInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
