package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// diffSuburb reconciles one (source, suburb) sweep against the stored listings in
// a single transaction, emitting the price/status/lifecycle events. The whole
// tier's integrity rests on the delist safety here: a listing is only ever marked
// gone when the sweep is COMPLETE (paged to an empty/duplicate page) AND the
// listing has been absent for delistGrace consecutive complete sweeps — a
// partial or blocked sweep updates only what it saw and delists nothing.
func (lc *listingsCrawler) diffSuburb(ctx context.Context, pool *pgxpool.Pool, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if sweep.status == sweepBlocked {
		return 0, nil // saw nothing believable — touch nothing
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	regionCode := t.regionCode()
	seen := make(map[string]bool, len(sweep.listings))
	events := 0

	for _, l := range sweep.listings {
		if l.ListingID == "" {
			continue
		}
		seen[l.ListingID] = true

		prev, err := loadListing(ctx, tx, source, l.ListingID)
		if err != nil {
			return events, err
		}

		evs, priceMoved := lc.eventsFor(prev, l)
		var lastPriceChange *time.Time
		if priceMoved {
			lastPriceChange = &runTs
		}

		pk, err := upsertListing(ctx, tx, l, t, runTs, lastPriceChange)
		if err != nil {
			return events, err
		}

		for _, e := range evs {
			e.ListingPK = pk
			e.Source = source
			e.ListingID = l.ListingID
			e.RegionCode = regionCode
			e.ObservedAt = runTs
			if err := insertPriceEvent(ctx, tx, e); err != nil {
				return events, err
			}
			events++
		}
	}

	// Absence / delist detection — only on a COMPLETE sweep.
	if sweep.status == sweepComplete {
		actives, err := activeListingsForRegion(ctx, tx, source, regionCode)
		if err != nil {
			return events, err
		}
		for _, a := range actives {
			if seen[a.ListingID] {
				continue
			}
			missed := a.MissedSweeps + 1
			delist := int(missed) >= lc.cfg.delistGrace
			if err := markAbsent(ctx, tx, a.PK, missed, delist); err != nil {
				return events, err
			}
			if delist {
				if err := insertPriceEvent(ctx, tx, priceEvent{
					ListingPK:  a.PK,
					Source:     source,
					ListingID:  a.ListingID,
					RegionCode: regionCode,
					ObservedAt: runTs,
					EventType:  "delisted",
					PrevStatus: a.Status,
					Status:     "withdrawn",
				}); err != nil {
					return events, err
				}
				events++
				lc.stats.delisted++
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return events, err
	}
	return events, nil
}

// eventsFor computes the events a single listing produces given its stored
// snapshot (prev, nil if new). priceMoved reports whether a drop/rise fired (so
// the caller can advance last_price_change_at).
func (lc *listingsCrawler) eventsFor(prev *storedListing, l RawListing) (evs []priceEvent, priceMoved bool) {
	cur := canonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind)

	base := priceEvent{
		Price:        cur,
		PriceHigh:    l.PriceHigh,
		PriceDisplay: l.PriceDisplay,
		PriceKind:    l.PriceKind,
		Status:       l.Status,
	}

	if prev == nil {
		e := base
		e.EventType = "first_seen"
		lc.stats.newListings++
		return []priceEvent{e}, false
	}

	relisted := false
	if !prev.IsActive {
		e := base
		e.EventType = "relisted"
		e.PrevPrice = prev.Price
		e.PrevStatus = prev.Status
		evs = append(evs, e)
		relisted = true
		lc.stats.relisted++
	}

	// status_change (suppressed when relisted already conveys the transition).
	if !relisted && l.Status != "" && prev.Status != l.Status {
		e := base
		e.EventType = "status_change"
		e.PrevStatus = prev.Status
		evs = append(evs, e)
		lc.stats.statusChanges++
	}

	// price move — only comparable like-kind numerics, past both noise thresholds,
	// and never when the listing just SOLD (for_sale→sold is a status_change, and
	// the sold price vs the asking price is not a vendor discount).
	if l.Status != "sold" && prev.Price != nil && cur != nil && comparableKinds(prev.PriceKind, l.PriceKind) {
		delta := *prev.Price - *cur // positive == a drop
		pct := delta / *prev.Price
		switch {
		case delta >= lc.cfg.noiseAbs && pct >= lc.cfg.noisePct:
			e := base
			e.EventType = "price_drop"
			e.PrevPrice = prev.Price
			e.DropAbs = f64p(delta)
			e.DropPct = f64p(pct)
			evs = append(evs, e)
			priceMoved = true
			lc.stats.drops++
		case delta <= -lc.cfg.noiseAbs && pct <= -lc.cfg.noisePct:
			e := base
			e.EventType = "price_rise"
			e.PrevPrice = prev.Price
			e.DropAbs = f64p(delta)
			e.DropPct = f64p(pct)
			evs = append(evs, e)
			priceMoved = true
			lc.stats.rises++
		}
	}

	return evs, priceMoved
}
