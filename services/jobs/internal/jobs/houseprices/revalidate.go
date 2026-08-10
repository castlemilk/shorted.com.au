package houseprices

import (
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// housingRevalidatePaths is the housing cache-bust contract: /api/revalidate
// takes a comma-separated `path` list, and the two ISR surfaces fed by this
// collector are the price-drops board and the housing tracker. Kept as a named
// var so the ported contract test can assert on it directly.
var housingRevalidatePaths = []string{"/price-drops", "/housing"}

// pingRevalidate tells the web tier to bust its long-TTL caches the instant a
// crawl-driven MV refresh changes the housing data, so /price-drops and /housing
// re-render with fresh data instead of waiting out their ISR ceiling. It is
// best-effort by design: a revalidation failure must NEVER fail or abort a run
// (callers ignore it), and it no-ops silently when REVALIDATION_URL /
// REVALIDATION_SECRET are unset — pages just self-heal on the ISR TTL.
//
// reason is a short tag identifying the call site (e.g. "agent", "listings",
// "refresh") so a scan of the run log shows which path pinged.
//
// This service ORIGINATED platform.PingRevalidate (the shared helper was lifted
// from this file), and the shared helper covers the housing contract exactly:
// `?path=/price-drops,/housing&flush=housing` plus X-Revalidate-Secret, no `tag`, POST,
// Content-Type application/json, non-2xx tolerated, 45s deadline on a DETACHED
// context — so a run's CRAWL_TIMEOUT_MIN expiring between the write and the ping
// can't kill the cache bust for data that is already committed. This is
// therefore a thin adapter, not a second copy, and the ~10 crawl-side call sites
// stay byte-identical.
func pingRevalidate(reason string) {
	platform.PingRevalidate(platform.RevalidateRequest{
		Reason: reason,
		Paths:  housingRevalidatePaths,
		Flush:  "housing",
		// Tag is intentionally unset — the flush=housing branch busts the
		// housing surfaces by path, no per-tag revalidation needed here.
	})
}
