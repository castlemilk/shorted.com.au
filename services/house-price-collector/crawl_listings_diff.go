package main

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
		// content hash, and row upsert — an unsanitised byte is a Postgres 22021.
		// (This is the FIRST line of defence; the SAVEPOINT below is the second,
		// catching any OTHER permanent per-row error.) See cleanText.
		l = sanitizeListing(l)
		// Mark seen BEFORE the savepoint attempt: a listing we saw but then had to
		// SKIP (permanent row error) must still count as present, or the SAME-sweep
		// delist pass below would treat it as absent. (The CROSS-sweep grace counter
		// is handled by markSeenOnly in the skip path — see there.)
		seen[l.ListingID] = true

		// Stamp the per-address identity from the CANONICAL target suburb/
		// state/postcode (never the portal's own address fields) — see
		// crawl_address.go. This is what unifies REA and Domain on the same
		// physical address regardless of how each portal formats it.
		l.AddressKey = addressKey(l.DisplayAddr, t.Display, t.State, t.Postcode)

		// Diff each listing inside its OWN savepoint so a single poison row can't
		// abort the whole suburb. A PERMANENT error (bad byte / out-of-range /
		// constraint — recurs identically every crawl) rolls back just this
		// listing and the suburb continues (clean continuation). A TRANSIENT error
		// (connection/deadlock/ctx) is propagated to fail + requeue the suburb —
		// the same behaviour #285 introduced, now scoped so it fires only for
		// genuinely-retryable failures instead of poison-pilling on a bad row.
		// (pgx's nested-tx Rollback issues ROLLBACK TO without RELEASE, so each
		// SKIP leaves its savepoint on the stack; a suburb would need >64 permanent
		// skips in one tx to reach Postgres's subxid-cache limit — and such a
		// systematic all-skipped suburb is failed by agentJobTerminal anyway, so
		// the extractor gets fixed long before that.)
		statsBefore := lc.stats // value copy (all-int struct) — restore point if this listing is skipped
		sp, err := tx.Begin(ctx)
		if err != nil {
			return events, err // can't even open a savepoint → the tx/conn is unhealthy → transient
		}
		n, derr := lc.diffListing(ctx, sp, l, t, source, runTs)
		if derr != nil {
			_ = sp.Rollback(ctx) // undo this listing's partial work; the parent tx stays healthy
			if isPermanentRowError(derr) {
				// Undo the in-memory event counters diffListing bumped: eventsFor/
				// addressPriceMove mutate lc.stats BEFORE the write that failed, and
				// the savepoint rollback undoes the DB writes but not those Go-side
				// counters — so restore them to keep the run summary honest.
				lc.stats = statsBefore
				lc.stats.skippedRows++
				// The listing IS present — we just can't persist its snapshot. Reset
				// its cross-sweep absence counter (missed_sweeps) + last_seen_at so an
				// intermittent permanent error can't let it drift up to delistGrace and
				// WRONGLY withdraw a live listing. No-op for a brand-new listing.
				if err := markSeenOnly(ctx, tx, source, l.ListingID, runTs); err != nil {
					return events, err
				}
				log.Printf("[listings] %s %s: skipping listing %s (permanent row error, kept the rest of the suburb): %v", t.Display, source, l.ListingID, derr)
				continue
			}
			return events, derr // transient → fail the suburb so it re-crawls
		}
		if err := sp.Commit(ctx); err != nil { // RELEASE SAVEPOINT
			return events, err
		}
		events += n
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

// diffListing diffs + upserts ONE (already-sanitised, AddressKey-stamped) listing
// into tx and returns the number of price events it wrote. diffSuburb runs it
// inside a per-listing SAVEPOINT, so an error here is caught there: a permanent
// (bad-row) error rolls back just this listing and the suburb continues; a
// transient error is propagated to fail + requeue the whole suburb. On any error
// the returned count is discarded by the caller (the savepoint rollback undoes
// every write this made), so the count is only meaningful on success.
func (lc *listingsCrawler) diffListing(ctx context.Context, tx pgx.Tx, l RawListing, t CrawlTarget, source string, runTs time.Time) (int, error) {
	regionCode := t.regionCode()

	prev, err := loadListing(ctx, tx, source, l.ListingID)
	if err != nil {
		return 0, err
	}

	evs, priceMoved := lc.eventsFor(prev, l)

	// Address-level relist-drop detection: a brand-new listing_id (this portal has
	// never seen it) at a KNOWN address, priced against that address's most recent
	// active listing across ANY source/listing_id — the drop a listing_id-keyed
	// diff alone can never see. Only for genuinely new listing_ids (prev == nil).
	if prev == nil && l.AddressKey != "" {
		addrPrior, err := loadAddressPrior(ctx, tx, l.AddressKey, l.ListingID, source)
		if err != nil {
			return 0, err
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
		return 0, err
	}

	events := 0
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
	return events, nil
}

// isPermanentRowError reports whether err is a per-ROW data problem that will
// recur identically on every re-crawl — a bad byte / out-of-range numeric (class
// 22 data-exception) or a constraint violation (class 23) — so diffSuburb can
// skip the single offending listing and keep the suburb. Everything else (a
// connection drop, a deadlock/serialisation failure, ctx cancellation, or any
// non-Postgres error) is TRANSIENT: it is propagated so the suburb fails +
// requeues rather than silently dropping data on a blip. Conservative by design —
// only KNOWN-permanent data errors are isolated-and-skipped; anything ambiguous
// fails safe (re-crawl).
func isPermanentRowError(err error) bool {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return false // not a Postgres error (network/driver) → transient
	}
	if len(pg.Code) < 2 {
		return false
	}
	switch pg.Code[:2] {
	case "22", // data exception: invalid byte sequence, numeric out of range, value too long, invalid text repr
		"23", // integrity constraint violation: not-null / check / foreign-key / (an un-ON-CONFLICTed) unique
		"54": // program_limit_exceeded: e.g. 54000 index row too large for a giant text value — recurs every crawl
		return true
	default:
		// Everything else (class 08 connection, 40 deadlock/serialisation, 53
		// insufficient-resources, 57 operator-intervention, 25 tx-state, 42
		// schema/query bug, ...) is TRANSIENT or a code bug that must fail LOUDLY
		// rather than be silently skipped row-by-row.
		return false
	}
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
