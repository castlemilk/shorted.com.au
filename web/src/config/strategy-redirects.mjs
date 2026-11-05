// The `/picks` URLs the stock picker answered at before it moved to `/strategies`.
//
// No imports, on purpose. next.config.mjs imports this file, and so does
// scripts/tests/strategy-redirects.test.mjs, which runs in the repo-hygiene CI
// job where nothing under web/ is installed (the same reason as
// stock-tab-redirects.mjs).
//
// Both rules are permanent (308). `/picks/:path*` also matches bare `/picks`
// in Next's path-to-regexp, so the first rule is kept explicit: it reads as
// the hub redirect, and it is what the tests pin.
//
// `public/picks-art/` is an asset folder, not a route, and is never renamed.
// Its paths start `/picks-art/`, which the `/picks/` rule cannot match because
// the source requires a slash directly after `picks`.

/**
 * @returns {{ source: string, destination: string, permanent: boolean }[]}
 */
export function strategyRedirects() {
  return [
    { source: "/picks", destination: "/strategies", permanent: true },
    {
      source: "/picks/:path*",
      destination: "/strategies/:path*",
      permanent: true,
    },
  ];
}
