package picks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// Revalidation after the refresh (plan fundamentals-coverage.md §3.8).
//
// The picks pages are ISR over the API's strategy cache, which holds a
// strategy's evaluation for 15 minutes. Busting the web tier's cache the
// moment the views refresh would re-render from a still-cached API answer and
// pin the OLD picks for another hour, so the ping waits until the API's cache
// has turned over: 15 minutes plus one.
const revalidateWait = 16 * time.Minute

// Cache tags the web tier revalidates. No path list and no copy of the
// strategy ids here: the web decides what a tag covers.
const (
	tagStrategyPicks = "strategy-picks"
	tagFundamentals  = "fundamentals"
)

// revalidator is the refresh step's cache-bust side, a seam for tests.
type revalidator struct {
	wait  time.Duration
	sleep func(ctx context.Context, d time.Duration) error
	ping  func(platform.RevalidateRequest)
}

func defaultRevalidator() revalidator {
	return revalidator{wait: revalidateWait, sleep: sleepCtx, ping: platform.PingRevalidate}
}

// runRefresh calls refresh_strategy_views() and fails when any picker view was
// not refreshed: the function catches every error per view and returns
// normally, so its `Skipping` WARNINGs are one kind of evidence a view went
// stale (task db:prod:refresh applies the same rule), and a view that exists
// but the live function body never names (no `Refreshing` NOTICE for it) is
// the other (pgStore.RefreshStrategyViews reports both).
func runRefresh(ctx context.Context, st store, dryRun bool, logf func(string, ...any)) error {
	if dryRun {
		logf("picks: dry run: would call refresh_strategy_views()")
		return nil
	}
	if st == nil {
		return errors.New("refresh: no database")
	}
	start := time.Now()
	skipped, err := st.RefreshStrategyViews(ctx)
	if err != nil {
		return err
	}
	if len(skipped) > 0 {
		return fmt.Errorf("refresh_strategy_views skipped %d view(s): %s", len(skipped), strings.Join(skipped, ", "))
	}
	logf("picks: refresh_strategy_views ok in %s", time.Since(start).Round(time.Millisecond))
	return nil
}

// revalidateAfterRefresh runs after a SUCCESSFUL refresh only: it waits
// rv.wait and pings the web tier, best-effort. Tag strategy-picks always,
// plus fundamentals when this execution's fundamentals or filings step
// changed stock_fundamentals (fundamentalsChanged). A cancelled wait skips
// the ping: the refresh itself succeeded, and the pages self-heal on their ISR
// TTL. Never an error, never a failed run (platform.PingRevalidate's
// contract).
func revalidateAfterRefresh(ctx context.Context, rv revalidator, fundamentalsChanged bool, logf func(string, ...any)) {
	if rv.ping == nil {
		return
	}
	tags := revalidateTags(fundamentalsChanged)
	logf("picks: waiting %s for the API's strategy cache to turn over before revalidating %s", rv.wait, tags)
	if rv.wait > 0 && rv.sleep != nil {
		if err := rv.sleep(ctx, rv.wait); err != nil {
			logf("picks: revalidation skipped (%v); pages self-heal on their ISR TTL", err)
			return
		}
	}
	rv.ping(platform.RevalidateRequest{Reason: "picks", Tag: tags})
}

// revalidateTags is the comma-joined tag list (the shape /api/revalidate
// accepts, as short-data-sync's "shorts-data,scan-results").
func revalidateTags(fundamentalsChanged bool) string {
	if fundamentalsChanged {
		return tagStrategyPicks + "," + tagFundamentals
	}
	return tagStrategyPicks
}
