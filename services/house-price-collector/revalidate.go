package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The web tier's housing caches are expired at two scopes, by what changed.
//
// A CRAWL write (pingCrawlRevalidate: crawl-finalize, -mode agent, -mode
// listings, the drain's -mode revalidate) changes listings and price events.
// Those reach the web as /price-drops and the cache:housing:drops: KV entries,
// and as each suburb profile's listing_stats block. The profile read is
// untagged, so a suburb page picks up new listing stats on its own 24h ISR
// window. A crawl ping therefore expires /price-drops and the housing KV
// family. It never sends the `housing` tag or the /housing path.
//
// The path matters as much as the tag. On Vercel, a plain revalidatePath(p)
// expires every page under p, not only p. The first crawl pings without the
// tag (2026-11-09 05:00 and 05:30) still sent path=/housing, and 12 of the 13
// /housing/* pages cached before the 05:30 ping came back REVALIDATED
// delete_tag after it. Stock, economy and ownership pages kept their entries.
// The /housing hub renders official data only (getHousingOverview; its
// price-drops panel is a client island that reads the flushed KV), so a
// crawl write has nothing to refresh there.
//
// An OFFICIAL data refresh (pingRevalidate, sent only by refresh(): the monthly
// run, the VG rig modes, crime, -mode refresh) changes sold prices, growth and
// the reference data. Those feed the `housing`-tagged reads: the state-suburb
// index (getHousingStateIndex.ts), the capital-city prices and the rankings.
// Every state and suburb page reads the index, so the tag expires all of them:
// the ~15,000 suburb pages and the state pages.
//
// Keep the tag and the /housing path out of crawl pings. Once the server-side crawl went live
// (2026-10-31), crawl-finalize ran every 30 minutes and pinged whenever the
// fleet's ingest had written, about 20 times a day. Every ping sent the tag, so
// every suburb page was rebuilt each time for data none of the tagged reads
// contain. On 2026-11-08 most housing re-renders were `REVALIDATED delete_tag`:
// 300–470 per half hour, about 10 times the stock pages.
// TestOnlyRefreshSendsTheHousingTag pins the one caller.
//
// Both pings are best-effort by design: a revalidation failure must NEVER fail
// or abort a run (callers ignore it), and a ping no-ops silently when
// REVALIDATION_URL / REVALIDATION_SECRET are unset, because pages self-heal on
// the ISR TTL.
//
// reason is a short tag identifying the call site (e.g. "agent", "listings",
// "refresh") so a scan of the run log shows which path pinged.
//
// The ping runs on a DETACHED context (context.Background + a short deadline),
// not the crawl context: a run's ctx can expire (CRAWL_TIMEOUT_MIN) right after
// the work + MV refresh finish, and the cache bust for ALREADY-persisted data
// must not be killed by that deadline firing between the write and the ping.
// Same rationale as the post-run queue submit in crawl_agent.go.

// crawlRevalidateQuery is the crawl write's cache bust: /price-drops, the one
// route that renders crawl-derived data on the server, and the housing KV
// family. The family is the whole cache:housing: prefix. A narrower drops-only
// flush would be silently ignored by a web tier that does not know its name
// yet. /price-drops has no pages beneath it but its card, so its expiry stays
// one page.
func crawlRevalidateQuery() url.Values {
	q := url.Values{}
	q.Set("path", "/price-drops")
	q.Set("flush", "housing")
	return q
}

// pingCrawlRevalidate sends a crawl write's cache bust (see above).
func pingCrawlRevalidate(reason string) {
	sendRevalidate(reason, "crawl", crawlRevalidateQuery())
}

// pingRevalidate sends the official data refresh's cache bust: the crawl's
// flush, the /price-drops and /housing paths, and the `housing` tag. The tag is
// the only part that reaches Next's data cache: `flush` deletes only Redis keys.
// Without it, after a data refresh every suburb page ranked against yesterday's
// state index for a full 24h. /api/revalidate calls revalidateTag() only for the
// tags supplied here. The /housing path rebuilds the hub over the new official
// figures (on Vercel it also expires the subtree, which the tag expires anyway).
// Only refresh() may call this.
func pingRevalidate(reason string) {
	q := crawlRevalidateQuery()
	q.Set("path", "/price-drops,/housing")
	q.Set("tag", "housing")
	sendRevalidate(reason, "housing", q)
}

// sendRevalidate POSTs one cache bust. scope names it in the log line.
func sendRevalidate(reason, scope string, q url.Values) {
	endpoint := os.Getenv("REVALIDATION_URL")
	secret := os.Getenv("REVALIDATION_SECRET")
	if endpoint == "" || secret == "" {
		log.Printf("[revalidate:%s] REVALIDATION_URL/REVALIDATION_SECRET not set; skipping cache bust", reason)
		return
	}
	reqURL := endpoint + "?" + q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: build request failed: %v", reason, redactURLError(err))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Revalidate-Secret", secret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: revalidation ping failed: %v", reason, redactURLError(err))
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		log.Printf("[revalidate:%s] WARNING: revalidation ping non-2xx (status %d): %s",
			reason, resp.StatusCode, strings.TrimSpace(string(snippet)))
		return
	}
	log.Printf("[revalidate:%s] %s cache bust ok (status %d)", reason, scope, resp.StatusCode)
}

// revalidateDeferEnv is set to 1 by the drain wrapper (hc_drain_until_empty in
// deploy/housing-crawl-common.sh) for each `-mode agent` round it runs.
const revalidateDeferEnv = "CRAWL_REVALIDATE_DEFER"

// revalidateDeferredMarker is the STABLE log text the drain greps for in a
// round's output to know the round wrote data and owes a cache bust. Changing it
// breaks hc_drain_until_empty: the drain would never ping.
const revalidateDeferredMarker = "deferred to the drain"

// revalidateMode is the -mode the drain runs to send that one bust. The
// wrapper names it literally, so renaming it alone leaves the drain calling a
// mode the binary does not have.
const revalidateMode = "revalidate"

// revalidateAfterCrawlWrite sends a crawl write's cache bust after a round
// refreshed the views over new data, unless the drain wrapper asked for one
// bust per drain. A ping purges /price-drops and /housing and flushes the whole
// housing KV prefix, and the first request after a purge renders while the
// visitor waits. Pinging per round purged them once per round, so through a
// drain nearly every /price-drops visit was that first request: on 2026-10-21
// two GETs 20 minutes apart both waited 44s, Age 0.
func revalidateAfterCrawlWrite(reason string) {
	if os.Getenv(revalidateDeferEnv) == "1" {
		log.Printf("[revalidate:%s] %s: it pings once for the whole drain", reason, revalidateDeferredMarker)
		return
	}
	pingCrawlRevalidate(reason)
}

// redactURLError keeps endpoint details out of transport-error logs. A raw
// *url.Error stringifies the FULL request URL, so an unwrapped transport failure
// prints the revalidation endpoint — and any query it carries — straight into the
// Cloud Run job log. The secret rides in a header now, but the redaction stays as
// defence in depth for the host and any future query input. The jobs-module copy
// of this path already did this via platform.PingRevalidate; the collector did
// not, and the collector is the copy production runs.
func redactURLError(err error) error {
	if uerr, ok := errors.AsType[*url.Error](err); ok {
		return fmt.Errorf("%s [url redacted]: %w", uerr.Op, uerr.Err)
	}
	return err
}
