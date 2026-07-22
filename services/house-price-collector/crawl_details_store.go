package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistence for the listing DETAIL tier. Writes go through a pgx.Tx so each
// listing's (upsert detail + backfill base row) commits atomically, matching the
// listing-diff store idioms (crawl_listings_store.go). The work-list cursor lives
// on property_listing_details.detail_fetched_at (the details row IS the "fetched"
// marker) — there is no separate base-row cursor.

// detailTarget is one work-list row: the active listing due a detail fetch, with
// just enough identity to fetch it and (on delist) write a price event.
type detailTarget struct {
	pk         int64
	source     string
	listingID  string
	url        string
	regionCode string
	addressKey string
}

// loadDetailWorklist returns the active listings due a detail fetch, newest work
// first. A listing is due when it has never been detail-fetched, when its asking
// price moved since the last detail fetch, or when the last fetch is older than
// 90 days (a periodic refresh so long-lived listings don't drift stale).
func loadDetailWorklist(ctx context.Context, pool *pgxpool.Pool, limit int) ([]detailTarget, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := pool.Query(ctx, `
		SELECT pl.id, pl.source, pl.listing_id, pl.listing_url,
		       COALESCE(pl.region_code, ''), COALESCE(pl.address_key, '')
		FROM property_listings pl
		LEFT JOIN property_listing_details d ON d.listing_pk = pl.id
		WHERE pl.is_active
		  AND (d.detail_fetched_at IS NULL
		       OR pl.last_price_change_at > d.detail_fetched_at
		       OR d.detail_fetched_at < now() - interval '90 days')
		ORDER BY (d.detail_fetched_at IS NULL) DESC,                       -- never-fetched first
		         (pl.last_price_change_at > d.detail_fetched_at) DESC NULLS LAST, -- then price-moved
		         pl.first_seen_at DESC                                     -- then freshest listings
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []detailTarget
	for rows.Next() {
		var d detailTarget
		if err := rows.Scan(&d.pk, &d.source, &d.listingID, &d.url, &d.regionCode, &d.addressKey); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// upsertListingDetail writes the latest detail snapshot for a listing. On conflict
// it refreshes every column + detail_fetched_at/updated_at. Free-text fields are
// run through cleanText (portal JSON carries NUL / lone-surrogate bytes Postgres
// rejects — same 22021 poison-pill as the listing store).
func upsertListingDetail(ctx context.Context, tx pgx.Tx, pk int64, source, status, finalURL string, rec detailRecord) error {
	// Final guard at the write boundary: strip any   escape so the `raw JSONB`
	// insert can't 22P05 (harvestDetail already cleans its inputs; this also covers
	// any raw that didn't come from harvestDetail).
	raw := stripJSONNul(rec.Raw)
	if raw == "" {
		raw = "{}"
	}
	h := sha1.Sum([]byte(raw))
	contentHash := hex.EncodeToString(h[:])

	_, err := tx.Exec(ctx, `
		INSERT INTO property_listing_details
			(listing_pk, source, detail_fetched_at, detail_status, http_final_url, description,
			 land_size_sqm, building_size_sqm, latitude, longitude, property_type, features,
			 image_count, inspection_next, auction_at, listed_at, agent_phones, raw, content_hash, updated_at)
		VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
		ON CONFLICT (listing_pk) DO UPDATE SET
			source = EXCLUDED.source,
			detail_fetched_at = now(),
			detail_status = EXCLUDED.detail_status,
			http_final_url = EXCLUDED.http_final_url,
			description = EXCLUDED.description,
			land_size_sqm = EXCLUDED.land_size_sqm,
			building_size_sqm = EXCLUDED.building_size_sqm,
			latitude = EXCLUDED.latitude,
			longitude = EXCLUDED.longitude,
			property_type = EXCLUDED.property_type,
			features = EXCLUDED.features,
			image_count = EXCLUDED.image_count,
			inspection_next = EXCLUDED.inspection_next,
			auction_at = EXCLUDED.auction_at,
			listed_at = EXCLUDED.listed_at,
			agent_phones = EXCLUDED.agent_phones,
			raw = EXCLUDED.raw,
			content_hash = EXCLUDED.content_hash,
			updated_at = now()`,
		pk, source, status, cleanText(finalURL), cleanText(rec.Description),
		rec.LandSizeSqm, rec.BuildingSizeSqm, rec.Lat, rec.Lng, cleanText(rec.PropertyType), cleanTexts(rec.Features),
		rec.ImageCount, rec.InspectionNext, rec.AuctionAt, rec.ListedAt, cleanTexts(rec.AgentPhones), raw, contentHash)
	return err
}

// stripJSONNul removes any literal `\u0000` escape sequence from a marshaled JSON
// string. Postgres jsonb rejects \u0000 (SQLSTATE 22P05) even though it is valid
// JSON, so it must never reach the `raw JSONB` insert.
func stripJSONNul(s string) string {
	if !strings.Contains(s, `\u0000`) {
		return s
	}
	return strings.ReplaceAll(s, `\u0000`, "")
}

// backfillBaseRow fills the base listing's lat/lng/land_size_sqm/property_type from
// the harvested detail, but ONLY where the base value is missing (NULL) or zero —
// the SRP sweep is the source of truth for anything it already captured. This is
// how the detail crawl closes REA's SRP geo/land/type gap on the base row itself.
func backfillBaseRow(ctx context.Context, tx pgx.Tx, pk int64, rec detailRecord) error {
	_, err := tx.Exec(ctx, `
		UPDATE property_listings SET
			latitude = COALESCE(latitude, $2),
			longitude = COALESCE(longitude, $3),
			land_size_sqm = CASE WHEN land_size_sqm IS NULL OR land_size_sqm = 0 THEN $4 ELSE land_size_sqm END,
			property_type = CASE WHEN property_type IS NULL OR property_type = '' THEN $5 ELSE property_type END
		WHERE id = $1
		  AND (latitude IS NULL OR longitude IS NULL
		       OR land_size_sqm IS NULL OR land_size_sqm = 0
		       OR property_type IS NULL OR property_type = '')`,
		pk, rec.Lat, rec.Lng, rec.LandSizeSqm, cleanTextOrNil(rec.PropertyType))
	return err
}

// cleanTexts sanitizes every element of a text slice; nil stays nil (→ SQL NULL).
func cleanTexts(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, s := range in {
		out = append(out, cleanText(s))
	}
	return out
}

// cleanTextOrNil returns a cleaned pointer, or nil for an empty string so the
// COALESCE/CASE backfill above treats "not harvested" as "don't touch".
func cleanTextOrNil(s string) *string {
	s = cleanText(s)
	if s == "" {
		return nil
	}
	return &s
}
