package houseprices

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Persistence for the address-seeded VALUATION tier. The work-list is DISTINCT
// addresses already in property_listings (the listing crawl's corpus) that are
// due a valuation fetch; the cursor lives on property_valuations.fetched_at (a row
// per address_key, upserted). pgx idioms match the listing store
// (crawl_listings_store.go): cleanText every free-text field, stripJSONNul the
// marshaled raw before insert.

// propertyTarget is one work-list row: a distinct physical address (by address_key)
// with the components needed to resolve its property.com.au profile URL.
type propertyTarget struct {
	addressKey     string
	displayAddress string
	suburb         string
	stateCode      string
	postcode       string
}

// loadPropertyWorklist returns the distinct active-listing addresses due a
// valuation fetch, never-fetched first then oldest. An address is due when it has
// no property_valuations row yet, or when its last fetch is older than ttlDays. We
// pick ONE representative listing row per address_key (the freshest) for its
// display address / suburb / state / postcode. Empty address_key rows are excluded
// — a stable key (and thus a resolvable URL) can't be formed without one.
func loadPropertyWorklist(ctx context.Context, pool *pgxpool.Pool, ttlDays, limit int) ([]propertyTarget, error) {
	if limit <= 0 {
		limit = 200
	}
	if ttlDays <= 0 {
		ttlDays = 90
	}
	rows, err := pool.Query(ctx, `
		WITH addrs AS (
			SELECT DISTINCT ON (pl.address_key)
				pl.address_key,
				COALESCE(pl.display_address, '') AS display_address,
				COALESCE(pl.suburb, '')          AS suburb,
				COALESCE(pl.state_code, '')      AS state_code,
				COALESCE(pl.postcode, '')        AS postcode
			FROM property_listings pl
			WHERE pl.is_active AND pl.address_key <> ''
			ORDER BY pl.address_key, pl.first_seen_at DESC
		)
		SELECT a.address_key, a.display_address, a.suburb, a.state_code, a.postcode
		FROM addrs a
		LEFT JOIN property_valuations pv ON pv.address_key = a.address_key
		WHERE pv.address_key IS NULL
		   OR pv.fetched_at < now() - ($1::int * interval '1 day')
		ORDER BY (pv.address_key IS NULL) DESC,        -- never-fetched first
		         pv.fetched_at ASC NULLS FIRST         -- then oldest-fetched
		LIMIT $2`, ttlDays, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []propertyTarget
	for rows.Next() {
		var t propertyTarget
		if err := rows.Scan(&t.addressKey, &t.displayAddress, &t.suburb, &t.stateCode, &t.postcode); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// upsertPropertyValuation writes the latest valuation snapshot for an address. On
// conflict it refreshes every column + fetched_at/updated_at. Free-text fields are
// cleanText'd and the raw JSON is stripJSONNul'd (portal JSON carries NUL /
// lone-surrogate bytes Postgres jsonb rejects — the same 22P05 poison-pill guarded
// in the listing-detail store). content_hash is the sha1 of the raw payload.
func upsertPropertyValuation(ctx context.Context, pool *pgxpool.Pool, t propertyTarget, status, granularity, profileURL string, p propertyProfile) error {
	raw := stripJSONNul(p.Raw)
	if raw == "" {
		raw = "{}"
	}
	h := sha1.Sum([]byte(raw))
	contentHash := hex.EncodeToString(h[:])

	// sales_history is its own JSONB column; nil slice → SQL NULL.
	var salesJSON any
	if len(p.SalesHistory) > 0 {
		if b, err := json.Marshal(p.SalesHistory); err == nil {
			salesJSON = stripJSONNul(string(b))
		}
	}

	// valuation_granularity distinguishes a dwelling-precise AVM ('exact') from a
	// whole-BUILDING AVM stored against a unit's address_key ('building'); empty →
	// SQL NULL (notfound/error rows carry no valuation).
	var granularityVal any
	if granularity != "" {
		granularityVal = granularity
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO property_valuations
			(address_key, source, profile_url, fetched_at, fetch_status, valuation_granularity,
			 estimate_low, estimate_mid, estimate_high, estimate_confidence, rent_estimate_mid,
			 bedrooms, bathrooms, car_spaces, land_size_sqm, building_size_sqm, year_built,
			 property_type, latitude, longitude, sales_history, raw, content_hash, updated_at)
		VALUES ($1,'property.com.au',$2, now(), $3, $4,
		        $5,$6,$7,$8,$9,
		        $10,$11,$12,$13,$14,$15,
		        $16,$17,$18,$19,$20,$21, now())
		ON CONFLICT (address_key) DO UPDATE SET
			profile_url = EXCLUDED.profile_url,
			fetched_at = now(),
			fetch_status = EXCLUDED.fetch_status,
			valuation_granularity = EXCLUDED.valuation_granularity,
			estimate_low = EXCLUDED.estimate_low,
			estimate_mid = EXCLUDED.estimate_mid,
			estimate_high = EXCLUDED.estimate_high,
			estimate_confidence = EXCLUDED.estimate_confidence,
			rent_estimate_mid = EXCLUDED.rent_estimate_mid,
			bedrooms = EXCLUDED.bedrooms,
			bathrooms = EXCLUDED.bathrooms,
			car_spaces = EXCLUDED.car_spaces,
			land_size_sqm = EXCLUDED.land_size_sqm,
			building_size_sqm = EXCLUDED.building_size_sqm,
			year_built = EXCLUDED.year_built,
			property_type = EXCLUDED.property_type,
			latitude = EXCLUDED.latitude,
			longitude = EXCLUDED.longitude,
			sales_history = EXCLUDED.sales_history,
			raw = EXCLUDED.raw,
			content_hash = EXCLUDED.content_hash,
			updated_at = now()`,
		t.addressKey, cleanText(profileURL), status, granularityVal,
		p.EstimateLow, p.EstimateMid, p.EstimateHigh, cleanText(p.EstimateConfidence), p.RentEstimateMid,
		p.Bedrooms, p.Bathrooms, p.CarSpaces, p.LandSizeSqm, p.BuildingSizeSqm, p.YearBuilt,
		cleanText(p.PropertyType), p.Lat, p.Lng, salesJSON, raw, contentHash)
	return err
}
