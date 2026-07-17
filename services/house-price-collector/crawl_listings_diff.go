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
		// Strip NUL / invalid-UTF8 from portal text BEFORE it feeds the events,
		// content hash, and row upsert — an unsanitised byte is a Postgres 22021
		// that would abort this whole transaction on every re-crawl (a poison
		// pill, now that a diff error fails+requeues the suburb). See cleanText.
		l = sanitizeListing(l)
		seen[l.ListingID] = true

		// Stamp the per-address identity from the CANONICAL target suburb/
		// state/postcode (never the portal's own address fields) — see
		// crawl_address.go. This is what unifies REA and Domain on the same
		// physical address regardless of how each portal formats it.
		l.AddressKey = addressKey(l.DisplayAddr, t.Display, t.State, t.Postcode)

		prev, err := loadListing(ctx, tx, source, l.ListingID)
		if err != nil {
			return events, err
		}

		evs, priceMoved := lc.eventsFor(prev, l)

		// Address-level relist-drop detection: a brand-new listing_id (this
		// portal has never seen it) at a KNOWN address, priced against that
		// address's most recent active listing across ANY source/listing_id.
		// This is the drop a listing_id-keyed diff alone can never see — a
		// relist under a fresh id, or the same address picked up on the other
		// portal. Only attempted for genuinely new listing_ids (prev == nil);
		// a listing we already track is diffed against its OWN history above.
		if prev == nil && l.AddressKey != "" {
			addrPrior, err := loadAddressPrior(ctx, tx, l.AddressKey, l.ListingID, source)
			if err != nil {
				return events, err
			}
			if e, ok := lc.addressPriceMove(addrPrior, l); ok {
				evs = append(evs, e)
				priceMoved = true
			}
		}

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
			e.AddressKey = l.AddressKey
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
					AddressKey: a.AddressKey,
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
	if e, ok := priceMoveEvent(lc.cfg, base, prev.Price, prev.PriceKind, l); ok {
		evs = append(evs, e)
		priceMoved = true
		if e.EventType == "price_drop" {
			lc.stats.drops++
		} else {
			lc.stats.rises++
		}
	}

	return evs, priceMoved
}

// priceMoveEvent compares l's current price against a prior (price, kind),
// applying the noise-threshold + comparable-kind gates: never fires on a
// non-comparable price-kind flip, an un-priced side (auction/POA/unknown), a
// sub-threshold wobble, or once the listing has SOLD (the sold price vs the
// asking price is not a vendor discount). Shared by eventsFor's listing-level
// diff (prior = the SAME listing_id's last snapshot) and addressPriceMove's
// address-level relist diff (prior = a DIFFERENT listing_id at the same
// address) — both hold a "price dropped" claim to the identical bar.
func priceMoveEvent(cfg listingsConfig, base priceEvent, priorPrice *float64, priorKind string, l RawListing) (priceEvent, bool) {
	cur := canonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind)
	if l.Status == "sold" || priorPrice == nil || cur == nil || !comparableKinds(priorKind, l.PriceKind) {
		return priceEvent{}, false
	}
	delta := *priorPrice - *cur // positive == a drop
	pct := delta / *priorPrice
	switch {
	case delta >= cfg.noiseAbs && pct >= cfg.noisePct:
		e := base
		e.EventType = "price_drop"
		e.PrevPrice = priorPrice
		e.DropAbs = f64p(delta)
		e.DropPct = f64p(pct)
		return e, true
	case delta <= -cfg.noiseAbs && pct <= -cfg.noisePct:
		e := base
		e.EventType = "price_rise"
		e.PrevPrice = priorPrice
		e.DropAbs = f64p(delta)
		e.DropPct = f64p(pct)
		return e, true
	}
	return priceEvent{}, false
}

// addressPriceMove computes a price_drop/price_rise for a brand-new listing_id
// against addrPrior — the most recent ACTIVE listing at the same address,
// possibly a different listing_id and/or source (loadAddressPrior,
// crawl_listings_store.go). This is the "the property relisted at a lower
// price" signal a listing_id-keyed diff alone can never see: a relist under a
// fresh id, or the same address picked up on the other portal. addrPrior==nil
// (no known prior at this address) is a no-op, and the same noise/comparable-
// kind gates as the listing-level diff apply, so a relist "discount" is held
// to the identical bar as an ordinary price drop — a listing re-crawled at
// genuinely the same price never fires.
func (lc *listingsCrawler) addressPriceMove(addrPrior *storedListing, l RawListing) (priceEvent, bool) {
	if addrPrior == nil {
		return priceEvent{}, false
	}
	base := priceEvent{
		Price:        canonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind),
		PriceHigh:    l.PriceHigh,
		PriceDisplay: l.PriceDisplay,
		PriceKind:    l.PriceKind,
		Status:       l.Status,
	}
	e, ok := priceMoveEvent(lc.cfg, base, addrPrior.Price, addrPrior.PriceKind, l)
	if !ok {
		return priceEvent{}, false
	}
	if e.EventType == "price_drop" {
		lc.stats.addressRelistDrops++
	} else {
		lc.stats.addressRelistRises++
	}
	return e, true
}
