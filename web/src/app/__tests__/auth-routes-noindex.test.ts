/**
 * `/signin` and `/signup` must stay out of the index.
 *
 * Why this exists: measured 2026-08-31 with a full 200-page crawl (OpenSEO
 * site audit), both routes shipped `index, follow` and — because neither had a
 * layout of its own — inherited the ROOT `alternates.canonical`, so every
 * variant declared `https://shorted.com.au` as its canonical URL.
 *
 * That matters because `intel-lock.tsx` renders a sign-in CTA on every locked
 * module with a per-page `?callbackUrl=`, fanning the route out into ~1,600
 * near-identical crawlable URLs (one per stock page, plus housing/politician/
 * economy variants). The crawler spent 7 of its 200-page budget on
 * `/signin?callbackUrl=%2Fshorts%2F*` before reaching real content. This site
 * has already lost a crawl budget to junk paths once — see
 * `robots.txt/__tests__/robots-rpc-disallow.test.ts`, where 56.7% of Googlebot
 * hits went to Connect-RPC endpoints.
 *
 * Deliberately NOT solved with a robots.txt `Disallow`: a disallowed URL can
 * never be crawled to see its `noindex`, which would strand any variant Google
 * has already indexed. Crawl-and-noindex is the de-indexing path; the
 * `rel="nofollow"` on the CTA is what protects the budget.
 */
import { metadata as signInMetadata } from "../signin/layout";
import { metadata as signUpMetadata } from "../signup/layout";

describe.each([
  ["/signin", signInMetadata],
  ["/signup", signUpMetadata],
])("%s metadata", (path, metadata) => {
  it("is noindex", () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("self-canonicalises instead of inheriting the root homepage canonical", () => {
    expect(metadata.alternates?.canonical).toBe(
      `https://shorted.com.au${path}`,
    );
  });
});
