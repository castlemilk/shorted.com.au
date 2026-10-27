package housingcrawl

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ApplySweep reconciles one (source, suburb) sweep against the stored listings in
// a single transaction, emitting the price/status/lifecycle events. The whole
// tier's integrity rests on the delist safety here: a listing is only ever marked
// gone when the sweep is COMPLETE (paged to an empty/duplicate page) AND the
// listing has been absent for DelistGrace consecutive complete sweeps — a
// partial or blocked sweep updates only what it saw and delists nothing.
//
// Before any write, the observed listings are gated: a listing that does not
// belong to sw.Target is dropped (MatchesTarget), and each price is clamped into
// the trusted band (ClampListingPrice), so events are derived from clamped prices
// only. For the collector these two steps are idempotent: its sweep already
// applied them, so they change nothing it writes.
//
// A BLOCKED sweep writes nothing. The returned Result is meaningful on error too.
//
// ApplySweep validates its input before it opens a transaction. It returns an
// error wrapping ErrInvalidSweep, with no writes, when the sweep is unsafe to
// apply: a zero DelistGrace or a non-positive noise threshold (an empty Config
// would delist on the first miss and record a $0 price_drop on every unchanged
// re-crawl), an unknown Status, a zero RunTS, or a listing whose Source is not the
// sweep's Source (the lookup uses the sweep's source, the write uses the
// listing's). The checks run before the BLOCKED return, so a malformed sweep is
// rejected whatever its status.
func ApplySweep(ctx context.Context, pool *pgxpool.Pool, sw Sweep) (Result, error) {
	if err := validateSweep(sw); err != nil {
		return Result{}, err
	}
	res := Result{Applied: sw.Status}
	if sw.Status == Blocked {
		return res, nil // saw nothing believable — touch nothing
	}

	listings := gateListings(sw.Target, sw.Listings)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	d := &differ{cfg: sw.Rules, res: &res, receipt: sw.ReceiptKey}
	events, err := d.applyTx(ctx, tx, sw, listings)
	res.Events = events
	if err != nil {
		return res, err
	}
	// The guard sees the diff exactly as it would commit, before the commit. A
	// refusal rolls the whole sweep back: the deferred Rollback below undoes every
	// write, including the delists.
	if sw.Guard != nil {
		if err := sw.Guard(res); err != nil {
			return res, fmt.Errorf("housingcrawl: sweep held before commit: %w", err)
		}
	}
	if sw.Record != nil {
		if err := sw.Record(ctx, tx, res); err != nil {
			return res, fmt.Errorf("housingcrawl: record before commit: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	return res, nil
}

// ErrInvalidSweep is wrapped by every error ApplySweep returns for a sweep it
// refuses to apply. Check it with errors.Is.
var ErrInvalidSweep = errors.New("invalid housing sweep")

// validateSweep reports the first rule a sweep breaks. It reads only the sweep, so
// it runs before any transaction is opened.
func validateSweep(sw Sweep) error {
	switch sw.Status {
	case Complete, Partial, Blocked:
	default:
		return fmt.Errorf("%w: unknown status %q", ErrInvalidSweep, sw.Status)
	}
	if sw.Rules.DelistGrace <= 0 {
		return fmt.Errorf("%w: DelistGrace must be > 0, got %d", ErrInvalidSweep, sw.Rules.DelistGrace)
	}
	if math.IsNaN(sw.Rules.NoiseAbs) || sw.Rules.NoiseAbs <= 0 {
		return fmt.Errorf("%w: NoiseAbs must be > 0, got %v", ErrInvalidSweep, sw.Rules.NoiseAbs)
	}
	if math.IsNaN(sw.Rules.NoisePct) || sw.Rules.NoisePct <= 0 {
		return fmt.Errorf("%w: NoisePct must be > 0, got %v", ErrInvalidSweep, sw.Rules.NoisePct)
	}
	if sw.Rules.MinDelistInterval < 0 {
		return fmt.Errorf("%w: MinDelistInterval must be >= 0, got %v", ErrInvalidSweep, sw.Rules.MinDelistInterval)
	}
	if sw.RunTS.IsZero() {
		return fmt.Errorf("%w: RunTS is zero", ErrInvalidSweep)
	}
	for _, l := range sw.Listings {
		if l.Source != sw.Source {
			return fmt.Errorf("%w: listing %q has source %q, sweep is %q", ErrInvalidSweep, l.ListingID, l.Source, sw.Source)
		}
	}
	return nil
}

// gateListings keeps the listings that belong to the target and clamps each
// price into the trusted band. Order is preserved.
func gateListings(t Target, in []RawListing) []RawListing {
	out := make([]RawListing, 0, len(in))
	for _, l := range in {
		if !MatchesTarget(l, t) {
			continue
		}
		out = append(out, ClampListingPrice(l))
	}
	return out
}

// differ carries the thresholds and the run counters through one sweep.
type differ struct {
	cfg Config
	res *Result
	// receipt is stamped on every row written, when non-empty (Sweep.ReceiptKey).
	receipt string
}

// applyTx runs the per-listing diffs and, on a COMPLETE sweep, the absence and
// delist pass, inside tx. It returns the events written. The caller commits.
func (d *differ) applyTx(ctx context.Context, tx pgx.Tx, sw Sweep, listings []RawListing) (int, error) {
	t := sw.Target
	source := sw.Source
	runTs := sw.RunTS
	regionCode := t.RegionCode()

	// The guard compares this sweep against what the region held before it wrote
	// anything, so count the active set first. Only a guarded sweep needs it.
	if sw.Guard != nil {
		n, err := countActiveForRegion(ctx, tx, source, regionCode)
		if err != nil {
			return 0, err
		}
		d.res.ActiveBefore = n
	}

	seen := make(map[string]bool, len(listings))
	events := 0

	for _, l := range listings {
		if l.ListingID == "" {
			continue
		}
		// Strip NUL / invalid-UTF8 from portal text BEFORE it feeds the events,
		// content hash, and row upsert — an unsanitised byte is a Postgres 22021.
		// (This is the FIRST line of defence; the SAVEPOINT below is the second,
		// catching any OTHER permanent per-row error.) See CleanText.
		l = SanitizeListing(l)
		// Mark seen BEFORE the savepoint attempt: a listing we saw but then had to
		// SKIP (permanent row error) must still count as present, or the SAME-sweep
		// delist pass below would treat it as absent. (The CROSS-sweep grace counter
		// is handled by markSeenOnly in the skip path — see there.)
		seen[l.ListingID] = true

		// Stamp the per-address identity from the CANONICAL target suburb/
		// state/postcode (never the portal's own address fields) — see AddressKey.
		// This is what unifies REA and Domain on the same physical address
		// regardless of how each portal formats it.
		l.AddressKey = AddressKey(l.DisplayAddr, t.Display, t.State, t.Postcode)

		// Diff each listing inside its OWN savepoint so a single poison row can't
		// abort the whole suburb. A PERMANENT error (bad byte / out-of-range /
		// constraint — recurs identically every crawl) rolls back just this
		// listing and the suburb continues (clean continuation). A TRANSIENT error
		// (connection/deadlock/ctx) is propagated to fail + requeue the suburb.
		// (pgx's nested-tx Rollback issues ROLLBACK TO without RELEASE, so each
		// SKIP leaves its savepoint on the stack; a suburb would need >64 permanent
		// skips in one tx to reach Postgres's subxid-cache limit — and such a
		// systematic all-skipped suburb is failed by the caller anyway, so the
		// extractor gets fixed long before that.)
		statsBefore := *d.res // value copy — restore point if this listing is skipped
		sp, err := tx.Begin(ctx)
		if err != nil {
			return events, err // can't even open a savepoint → the tx/conn is unhealthy → transient
		}
		n, derr := d.diffListing(ctx, sp, l, t, source, runTs)
		if derr != nil {
			_ = sp.Rollback(ctx) // undo this listing's partial work; the parent tx stays healthy
			if isPermanentRowError(derr) {
				// Undo the in-memory counters diffListing bumped before the write that
				// failed: the savepoint rollback undoes the DB writes but not these, so
				// restore them to keep the run summary honest.
				*d.res = statsBefore
				d.res.SkippedRows++
				// The listing IS present — we just can't persist its snapshot. Reset
				// its cross-sweep absence counter (missed_sweeps) + last_seen_at so an
				// intermittent permanent error can't let it drift up to DelistGrace and
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
	if sw.Status == Complete {
		actives, err := activeListingsForRegion(ctx, tx, source, regionCode)
		if err != nil {
			return events, err
		}
		for _, a := range actives {
			if seen[a.ListingID] {
				continue
			}
			// At most one absence per listing per MinDelistInterval. A listing
			// missed again inside the interval is left exactly as it is: no
			// missed_sweeps advance, no delist, no write.
			if d.cfg.MinDelistInterval > 0 && a.LastMissedAt != nil &&
				runTs.Sub(*a.LastMissedAt) < d.cfg.MinDelistInterval {
				continue
			}
			missed := a.MissedSweeps + 1
			delist := int(missed) >= d.cfg.DelistGrace
			if err := markAbsentAt(ctx, tx, a.PK, missed, delist, runTs, d.receipt); err != nil {
				return events, err
			}
			if delist {
				if err := InsertPriceEvent(ctx, tx, PriceEvent{
					ListingPK:  a.PK,
					Source:     source,
					ListingID:  a.ListingID,
					RegionCode: regionCode,
					AddressKey: a.AddressKey,
					ObservedAt: runTs,
					EventType:  "delisted",
					PrevStatus: a.Status,
					Status:     "withdrawn",
					ReceiptKey: d.receipt,
				}); err != nil {
					return events, err
				}
				events++
				d.res.Delisted++
			}
		}
	}
	return events, nil
}

// diffListing diffs + upserts ONE (already-sanitised, AddressKey-stamped) listing
// into tx and returns the number of price events it wrote. applyTx runs it inside
// a per-listing SAVEPOINT, so an error here is caught there: a permanent (bad-row)
// error rolls back just this listing and the sweep continues; a transient error is
// propagated to fail + requeue the whole suburb. On any error the returned count
// is discarded by the caller (the savepoint rollback undoes every write this made),
// so the count is only meaningful on success.
func (d *differ) diffListing(ctx context.Context, tx pgx.Tx, l RawListing, t Target, source string, runTs time.Time) (int, error) {
	regionCode := t.RegionCode()

	prev, err := loadListing(ctx, tx, source, l.ListingID)
	if err != nil {
		return 0, err
	}

	evs, priceMoved := d.eventsFor(prev, l)

	// Address-level relist-drop detection: a brand-new listing_id (this portal has
	// never seen it) at a KNOWN address, priced against that address's most recent
	// eligible earlier advert of the same dwelling — the drop a listing_id-keyed
	// diff alone can never see. Only for genuinely new listing_ids (prev == nil).
	// loadAddressPrior skips the other portal's concurrent listing and other units
	// at a collapsed address, neither of which is a relist.
	if prev == nil && l.AddressKey != "" {
		addrPrior, err := loadAddressPrior(ctx, tx, l.AddressKey, l.ListingID, source, l.Bedrooms, runTs)
		if err != nil {
			return 0, err
		}
		if e, ok := d.addressPriceMove(addrPrior, l); ok {
			evs = append(evs, e)
			priceMoved = true
		}
	}

	var lastPriceChange *time.Time
	if priceMoved {
		lastPriceChange = &runTs
	}

	pk, err := upsertListing(ctx, tx, l, t, runTs, lastPriceChange, d.receipt)
	if err != nil {
		return 0, err
	}
	d.res.Upserted++

	events := 0
	for _, e := range evs {
		e.ListingPK = pk
		e.Source = source
		e.ListingID = l.ListingID
		e.RegionCode = regionCode
		e.AddressKey = l.AddressKey
		e.ObservedAt = runTs
		e.ReceiptKey = d.receipt
		if err := InsertPriceEvent(ctx, tx, e); err != nil {
			return events, err
		}
		events++
	}
	return events, nil
}

// eventsFor computes the events a single listing produces given its stored
// snapshot (prev, nil if new). priceMoved reports whether a drop/rise fired (so
// the caller can advance last_price_change_at).
func (d *differ) eventsFor(prev *storedListing, l RawListing) (evs []PriceEvent, priceMoved bool) {
	cur := CanonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind)

	base := PriceEvent{
		Price:        cur,
		PriceHigh:    l.PriceHigh,
		PriceDisplay: l.PriceDisplay,
		PriceKind:    l.PriceKind,
		Status:       l.Status,
	}

	if prev != nil {
		d.res.Existing++
		if largeMove(prev.Price, prev.PriceKind, cur, l.PriceKind, l.Status) {
			d.res.LargeMoves++
		}
	}

	if prev == nil {
		e := base
		e.EventType = "first_seen"
		d.res.NewListings++
		return []PriceEvent{e}, false
	}

	relisted := false
	if !prev.IsActive {
		e := base
		e.EventType = "relisted"
		e.PrevPrice = prev.Price
		e.PrevStatus = prev.Status
		evs = append(evs, e)
		relisted = true
		d.res.Relisted++
	}

	// status_change (suppressed when relisted already conveys the transition).
	if !relisted && l.Status != "" && prev.Status != l.Status {
		e := base
		e.EventType = "status_change"
		e.PrevStatus = prev.Status
		evs = append(evs, e)
		d.res.StatusChanges++
	}

	// price move — only comparable like-kind numerics, past both noise thresholds,
	// and never when the listing just SOLD (for_sale→sold is a status_change, and
	// the sold price vs the asking price is not a vendor discount).
	if e, ok := priceMoveEvent(d.cfg, base, prev.Price, prev.PriceKind, l); ok {
		evs = append(evs, e)
		priceMoved = true
		if e.EventType == "price_drop" {
			d.res.Drops++
		} else {
			d.res.Rises++
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
func priceMoveEvent(cfg Config, base PriceEvent, priorPrice *float64, priorKind string, l RawListing) (PriceEvent, bool) {
	cur := CanonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind)
	if l.Status == "sold" || priorPrice == nil || cur == nil || !ComparableKinds(priorKind, l.PriceKind) {
		return PriceEvent{}, false
	}
	delta := *priorPrice - *cur // positive == a drop
	pct := delta / *priorPrice
	switch {
	case delta >= cfg.NoiseAbs && pct >= cfg.NoisePct:
		e := base
		e.EventType = "price_drop"
		e.PrevPrice = priorPrice
		e.DropAbs = new(delta)
		e.DropPct = new(pct)
		return e, true
	case delta <= -cfg.NoiseAbs && pct <= -cfg.NoisePct:
		e := base
		e.EventType = "price_rise"
		e.PrevPrice = priorPrice
		e.DropAbs = new(delta)
		e.DropPct = new(pct)
		return e, true
	}
	return PriceEvent{}, false
}

// largeMove reports whether a fresh price differs from the stored one by more than
// LargeMoveFraction of the stored price. It applies the same exclusions as
// priceMoveEvent: a sold listing, an unpriced side and a non-comparable price kind
// never count. Exactly LargeMoveFraction does not count.
func largeMove(priorPrice *float64, priorKind string, cur *float64, curKind, status string) bool {
	if status == "sold" || priorPrice == nil || cur == nil || *priorPrice <= 0 ||
		!ComparableKinds(priorKind, curKind) {
		return false
	}
	return math.Abs(*priorPrice-*cur) / *priorPrice > LargeMoveFraction
}

// countActiveForRegion counts the active listings for a (source, region). It is
// the guard's baseline: the set a sweep can delist from, before the sweep wrote.
func countActiveForRegion(ctx context.Context, tx pgx.Tx, source, regionCode string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM property_listings
		WHERE source = $1 AND region_code = $2 AND is_active`,
		source, regionCode).Scan(&n)
	return n, err
}

// addressPriceMove computes a price_drop/price_rise for a brand-new listing_id
// against addrPrior — the most recent eligible ACTIVE listing of the same
// dwelling, possibly a different listing_id and/or source (loadAddressPrior).
// This is the "the property relisted at a lower price" signal a listing_id-keyed
// diff alone can never see. addrPrior==nil (no known prior at this address) is a
// no-op, and the same noise/comparable-kind gates as the listing-level diff apply,
// so a relist "discount" is held to the identical bar as an ordinary price drop —
// a listing re-crawled at genuinely the same price never fires.
func (d *differ) addressPriceMove(addrPrior *storedListing, l RawListing) (PriceEvent, bool) {
	if addrPrior == nil {
		return PriceEvent{}, false
	}
	base := PriceEvent{
		Price:        CanonicalPrice(l.PriceLow, l.PriceHigh, l.PriceKind),
		PriceHigh:    l.PriceHigh,
		PriceDisplay: l.PriceDisplay,
		PriceKind:    l.PriceKind,
		Status:       l.Status,
	}
	e, ok := priceMoveEvent(d.cfg, base, addrPrior.Price, addrPrior.PriceKind, l)
	if !ok {
		return PriceEvent{}, false
	}
	if e.EventType == "price_drop" {
		d.res.AddressRelistDrops++
	} else {
		d.res.AddressRelistRises++
	}
	return e, true
}

// isPermanentRowError reports whether err is a per-ROW data problem that will
// recur identically on every re-crawl — a bad byte / out-of-range numeric (class
// 22 data-exception) or a constraint violation (class 23) — so ApplySweep can skip
// the single offending listing and keep the sweep. Everything else (a connection
// drop, a deadlock/serialisation failure, ctx cancellation, or any non-Postgres
// error) is TRANSIENT: it is propagated so the suburb fails and requeues rather
// than silently dropping data on a blip.
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
