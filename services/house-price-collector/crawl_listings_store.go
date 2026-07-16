package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistence for the listing tier. Reads/writes go through a pgx.Tx so a whole
// suburb's diff (upserts + events + delists) commits atomically — a mid-write
// failure can never leave a suburb half-delisted.

// storedListing is the minimal snapshot of a listing already in the DB, loaded to
// diff against a freshly-crawled RawListing.
type storedListing struct {
	PK           int64
	ListingID    string
	AddressKey   string
	Price        *float64
	PriceKind    string
	Status       string
	IsActive     bool
	MissedSweeps int16
}

// priceEvent is one row for property_price_events.
type priceEvent struct {
	ListingPK    int64
	Source       string
	ListingID    string
	RegionCode   string
	AddressKey   string
	ObservedAt   time.Time
	EventType    string
	Price        *float64
	PriceHigh    *float64
	PriceDisplay string
	PriceKind    string
	PrevPrice    *float64
	DropAbs      *float64
	DropPct      *float64
	Status       string
	PrevStatus   string
}

// loadListing returns the stored snapshot for (source, listing_id), or nil when
// the listing has never been seen.
func loadListing(ctx context.Context, tx pgx.Tx, source, listingID string) (*storedListing, error) {
	var s storedListing
	err := tx.QueryRow(ctx, `
		SELECT id, address_key, price, price_kind, listing_status, is_active, missed_sweeps
		FROM property_listings WHERE source = $1 AND listing_id = $2`,
		source, listingID).Scan(&s.PK, &s.AddressKey, &s.Price, &s.PriceKind, &s.Status, &s.IsActive, &s.MissedSweeps)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.ListingID = listingID
	return &s, nil
}

// loadAddressPrior returns the most-recently-seen ACTIVE listing at addressKey,
// EXCLUDING the current (source, listingID) itself, across ANY source/
// listing_id — the candidate prior for addressPriceMove's relist-drop check
// (crawl_listings_diff.go). Returns nil when no other active listing is known
// at this address. "Most recent" is last_seen_at DESC, so a stale/never-
// refreshed sighting never wins over a listing this same suburb sweep just
// confirmed is still live.
func loadAddressPrior(ctx context.Context, tx pgx.Tx, addressKey, excludeListingID, excludeSource string) (*storedListing, error) {
	if addressKey == "" {
		return nil, nil
	}
	var s storedListing
	err := tx.QueryRow(ctx, `
		SELECT id, listing_id, address_key, price, price_kind, listing_status, is_active, missed_sweeps
		FROM property_listings
		WHERE address_key = $1 AND is_active
		  AND NOT (source = $2 AND listing_id = $3)
		ORDER BY last_seen_at DESC
		LIMIT 1`,
		addressKey, excludeSource, excludeListingID).
		Scan(&s.PK, &s.ListingID, &s.AddressKey, &s.Price, &s.PriceKind, &s.Status, &s.IsActive, &s.MissedSweeps)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// upsertListing writes the latest snapshot and returns the listing PK. On a
// re-sighting it bumps last_seen_at, resets missed_sweeps, and (only when a price
// move happened) advances last_price_change_at. first_seen_at is preserved.
func upsertListing(ctx context.Context, tx pgx.Tx, r RawListing, t CrawlTarget, runTs time.Time, lastPriceChange *time.Time) (int64, error) {
	price := canonicalPrice(r.PriceLow, r.PriceHigh, r.PriceKind)
	var pk int64
	err := tx.QueryRow(ctx, `
		INSERT INTO property_listings
			(source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode,
			 display_address, latitude, longitude, property_type, bedrooms, bathrooms,
			 car_spaces, land_size_sqm, price, price_high, price_display, price_kind,
			 listing_status, is_active, missed_sweeps, first_seen_at, last_seen_at,
			 last_price_change_at, content_hash, agency_id, agency_name, agent_names, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
			$25, 0, $22, $22, $23, $24, $26, $27, $28, now())
		ON CONFLICT (source, listing_id) DO UPDATE SET
			address_key = EXCLUDED.address_key,
			listing_url = EXCLUDED.listing_url, region_code = EXCLUDED.region_code,
			suburb = EXCLUDED.suburb, state_code = EXCLUDED.state_code, postcode = EXCLUDED.postcode,
			display_address = EXCLUDED.display_address, latitude = EXCLUDED.latitude,
			longitude = EXCLUDED.longitude, property_type = EXCLUDED.property_type,
			bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms, car_spaces = EXCLUDED.car_spaces,
			land_size_sqm = EXCLUDED.land_size_sqm, price = EXCLUDED.price, price_high = EXCLUDED.price_high,
			price_display = EXCLUDED.price_display, price_kind = EXCLUDED.price_kind,
			listing_status = EXCLUDED.listing_status, is_active = EXCLUDED.is_active, missed_sweeps = 0,
			last_seen_at = EXCLUDED.last_seen_at,
			last_price_change_at = COALESCE(EXCLUDED.last_price_change_at, property_listings.last_price_change_at),
			content_hash = EXCLUDED.content_hash,
			-- keep the last non-empty agency/agents (a later sweep that omitted them
			-- shouldn't wipe a good value)
			agency_id = COALESCE(NULLIF(EXCLUDED.agency_id, ''), property_listings.agency_id),
			agency_name = COALESCE(NULLIF(EXCLUDED.agency_name, ''), property_listings.agency_name),
			agent_names = CASE WHEN COALESCE(array_length(EXCLUDED.agent_names, 1), 0) > 0
			                   THEN EXCLUDED.agent_names ELSE property_listings.agent_names END,
			updated_at = now()
		RETURNING id`,
		r.Source, r.ListingID, r.AddressKey, r.ListingURL, t.regionCode(), r.Suburb, r.State, r.Postcode,
		r.DisplayAddr, r.Lat, r.Lng, r.PropertyType, r.Bedrooms, r.Bathrooms,
		r.CarSpaces, r.LandSizeSqm, price, r.PriceHigh, r.PriceDisplay, r.PriceKind,
		r.Status, runTs, lastPriceChange, listingContentHash(r), statusActive(r.Status),
		r.AgencyID, r.AgencyName, r.AgentNames).Scan(&pk)
	return pk, err
}

// statusActive reports whether a listing status counts as on-market: sold and
// withdrawn listings are inactive (they leave the for-sale pool + drop the
// delist/price-move logic).
func statusActive(status string) bool {
	return status != "sold" && status != "withdrawn"
}

// insertPriceEvent appends one event, idempotent on (listing_pk, event_type,
// observed_at) so a re-run of the same crawl is a perfect no-op.
func insertPriceEvent(ctx context.Context, tx pgx.Tx, ev priceEvent) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO property_price_events
			(listing_pk, source, listing_id, region_code, address_key, observed_at, event_type,
			 price, price_high, price_display, price_kind, prev_price, drop_abs, drop_pct,
			 listing_status, prev_status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (listing_pk, event_type, observed_at) DO NOTHING`,
		ev.ListingPK, ev.Source, ev.ListingID, ev.RegionCode, ev.AddressKey, ev.ObservedAt, ev.EventType,
		ev.Price, ev.PriceHigh, ev.PriceDisplay, ev.PriceKind, ev.PrevPrice, ev.DropAbs, ev.DropPct,
		ev.Status, ev.PrevStatus)
	return err
}

// activeListingsForRegion returns the currently-active listings for a (source,
// region) — the candidate set for absence/delist detection.
func activeListingsForRegion(ctx context.Context, tx pgx.Tx, source, regionCode string) ([]storedListing, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, listing_id, address_key, listing_status, missed_sweeps
		FROM property_listings
		WHERE source = $1 AND region_code = $2 AND is_active`,
		source, regionCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedListing
	for rows.Next() {
		var s storedListing
		if err := rows.Scan(&s.PK, &s.ListingID, &s.AddressKey, &s.Status, &s.MissedSweeps); err != nil {
			return nil, err
		}
		s.IsActive = true
		out = append(out, s)
	}
	return out, rows.Err()
}

// markAbsent records that an active listing was not seen this COMPLETE sweep:
// either bump its missed_sweeps counter, or (once the grace period is exhausted)
// flip it inactive/withdrawn.
func markAbsent(ctx context.Context, tx pgx.Tx, pk int64, missed int16, delist bool) error {
	if delist {
		_, err := tx.Exec(ctx, `
			UPDATE property_listings
			SET is_active = false, listing_status = 'withdrawn', missed_sweeps = $2, updated_at = now()
			WHERE id = $1`, pk, missed)
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE property_listings SET missed_sweeps = $2, updated_at = now() WHERE id = $1`, pk, missed)
	return err
}

// linkListingSalCodes copies each listing's ABS sal_code from its (already
// sal-linked) house_price_regions row. Run after linkSuburbSalCodes so the
// regions are populated first. Idempotent: only touches NULL sal_codes.
func linkListingSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `
		UPDATE property_listings pl SET sal_code = r.sal_code
		FROM house_price_regions r
		WHERE pl.region_code = r.region_code AND pl.sal_code IS NULL AND r.sal_code IS NOT NULL`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func listingContentHash(r RawListing) string {
	var price float64
	if cp := canonicalPrice(r.PriceLow, r.PriceHigh, r.PriceKind); cp != nil {
		price = *cp
	}
	h := sha1.Sum(fmt.Appendf(nil, "%s|%s|%s|%.2f|%s|%s|%s",
		r.ListingURL, r.PriceDisplay, r.PriceKind, price, r.Status, r.DisplayAddr, r.PropertyType))
	return hex.EncodeToString(h[:])
}
