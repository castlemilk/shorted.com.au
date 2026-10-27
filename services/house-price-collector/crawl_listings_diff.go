package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// diffSuburb applies one (source, suburb) sweep to the listing store through
// housingcrawl.ApplySweep. That is the same store logic the shorts ingest service
// runs on the sweeps the rig pushes, so the rig and the server cannot diverge. The
// result is folded into the run stats. On error the returned count is discarded by
// the caller, as before.
func (lc *listingsCrawler) diffSuburb(ctx context.Context, pool *pgxpool.Pool, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	res, err := housingcrawl.ApplySweep(ctx, pool, housingcrawl.Sweep{
		Target:   t.lib(),
		Source:   source,
		Status:   sweep.status.lib(),
		Pages:    sweep.pages,
		Listings: sweep.listings,
		RunTS:    runTs,
		Rules:    lc.cfg.rules(),
	})
	lc.stats.absorb(res)
	return res.Events, err
}

// writeSweep is the write seam for one (source, suburb) sweep. With no sink it is the
// local diff, unchanged. A sink (ingest or shadow, crawl_sink.go) takes the sweep
// instead, and the pool is never touched on that path.
func (lc *listingsCrawler) writeSweep(ctx context.Context, pool *pgxpool.Pool, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if lc.sink == nil {
		return lc.diffSuburb(ctx, pool, t, source, sweep, runTs)
	}
	return lc.sink.write(ctx, lc, t, source, sweep, runTs)
}

// lib maps the collector's sweep status onto the store's status.
func (s sweepStatus) lib() housingcrawl.SweepStatus {
	switch s {
	case sweepComplete:
		return housingcrawl.Complete
	case sweepPartial:
		return housingcrawl.Partial
	default:
		return housingcrawl.Blocked
	}
}

// lib returns the store's view of the target.
func (t CrawlTarget) lib() housingcrawl.Target {
	return housingcrawl.Target{Suburb: t.Suburb, Display: t.Display, Postcode: t.Postcode, State: t.State}
}

// rules returns the store's diff thresholds for this config.
func (c listingsConfig) rules() housingcrawl.Config {
	return housingcrawl.Config{DelistGrace: c.delistGrace, NoiseAbs: c.noiseAbs, NoisePct: c.noisePct}
}

// absorb adds one sweep's store counters into the run stats.
func (s *listingsStats) absorb(r housingcrawl.Result) {
	s.newListings += r.NewListings
	s.drops += r.Drops
	s.rises += r.Rises
	s.relisted += r.Relisted
	s.delisted += r.Delisted
	s.statusChanges += r.StatusChanges
	s.addressRelistDrops += r.AddressRelistDrops
	s.addressRelistRises += r.AddressRelistRises
	s.skippedRows += r.SkippedRows
}
