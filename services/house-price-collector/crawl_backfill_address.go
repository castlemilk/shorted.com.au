package main

import (
	"context"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// -mode backfill-address is a ONE-TIME pass (operator-run, not part of any
// scheduled mode) that derives address_key for every property_listings row
// already in the database — the listings ingested before this feature shipped
// — and propagates it onto their property_price_events rows. It is safe to
// re-run: both steps are idempotent (a listing/event whose stored address_key
// already matches the freshly-derived one is left untouched, so a re-run after
// new listings have accumulated only touches the new rows).

// runBackfillAddress orchestrates both passes and records the run cursor under
// "backfill_address_key".
func runBackfillAddress(ctx context.Context, pool *pgxpool.Pool) error {
	total, updated, err := backfillListingAddressKeys(ctx, pool)
	if err != nil {
		log.Printf("[backfill-address] listings error after %d/%d updated: %v", updated, total, err)
		_ = updateRun(ctx, pool, "backfill_address_key", nil, updated, "error", err.Error())
		return err
	}
	log.Printf("[backfill-address] listings: %d/%d rows updated (address_key derived from display_address+suburb+state_code+postcode)", updated, total)

	evUpdated, err := backfillPriceEventAddressKeys(ctx, pool)
	if err != nil {
		log.Printf("[backfill-address] price_events error: %v", err)
		_ = updateRun(ctx, pool, "backfill_address_key", nil, updated, "error", err.Error())
		return err
	}
	log.Printf("[backfill-address] price_events: %d rows updated", evUpdated)
	_ = updateRun(ctx, pool, "backfill_address_key", nil, updated+int(evUpdated), "ok", "")
	return nil
}

// addressBackfillRow is one property_listings row's address-identifying
// columns, as loaded for the backfill pass. The columns are all nullable in
// the schema, so they're scanned as pointers.
type addressBackfillRow struct {
	pk                             int64
	displayAddr, suburb, state, pc *string
}

// addressKeyForListing applies the exact same derivation the live crawl uses
// (crawl_address.go's addressKey) to a backfill row's (possibly NULL) columns
// — this is the pure, unit-testable core of the backfill.
func addressKeyForListing(r addressBackfillRow) string {
	return addressKey(strOrEmpty(r.displayAddr), strOrEmpty(r.suburb), strOrEmpty(r.state), strOrEmpty(r.pc))
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// backfillListingAddressKeys derives address_key for every property_listings
// row and writes it. Returns the total rows considered and the number
// actually changed (a re-run's already-correct rows report 0 changed, via the
// IS DISTINCT FROM guard).
func backfillListingAddressKeys(ctx context.Context, pool *pgxpool.Pool) (total, updated int, err error) {
	rows, err := pool.Query(ctx, `
		SELECT id, display_address, suburb, state_code, postcode
		FROM property_listings`)
	if err != nil {
		return 0, 0, err
	}
	var recs []addressBackfillRow
	for rows.Next() {
		var r addressBackfillRow
		if err := rows.Scan(&r.pk, &r.displayAddr, &r.suburb, &r.state, &r.pc); err != nil {
			rows.Close()
			return 0, 0, err
		}
		recs = append(recs, r)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	rows.Close()
	total = len(recs)
	if total == 0 {
		return 0, 0, nil
	}

	const q = `
		UPDATE property_listings SET address_key = $2, updated_at = now()
		WHERE id = $1 AND address_key IS DISTINCT FROM $2`
	batch := &pgx.Batch{}
	for _, r := range recs {
		batch.Queue(q, r.pk, addressKeyForListing(r))
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range recs {
		tag, execErr := br.Exec()
		if execErr != nil {
			return total, updated, execErr
		}
		updated += int(tag.RowsAffected())
	}
	return total, updated, nil
}

// backfillPriceEventAddressKeys propagates each listing's (now-populated)
// address_key onto its property_price_events rows, set-based (no per-row
// round trip needed — a single UPDATE...FROM join). Only rows whose
// listing has a non-empty address_key AND whose own address_key differs are
// touched, so a re-run is a cheap near-no-op.
func backfillPriceEventAddressKeys(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `
		UPDATE property_price_events e
		SET address_key = pl.address_key
		FROM property_listings pl
		WHERE e.listing_pk = pl.id
		  AND pl.address_key <> ''
		  AND e.address_key IS DISTINCT FROM pl.address_key`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
