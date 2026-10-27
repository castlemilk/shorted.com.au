package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// The listing store (diff, upserts, events, delists, the sanitizers and the
// finalize SQL) lives in housingcrawl, shared with the shorts ingest service.
// This file keeps the collector's thin adapters.

// finalizeTimeout bounds the end-of-run finalizer (sal-linking + MV refresh)
// on its DETACHED context — generous because refresh_housing_materialized_views
// on prod Supabase can take minutes, but bounded so a wedged pool can't hang a
// finished run forever.
const finalizeTimeout = 10 * time.Minute

// cleanText strips NUL bytes and coerces the string to valid UTF-8. See
// housingcrawl.CleanText.
func cleanText(s string) string {
	return housingcrawl.CleanText(s)
}

// priceEvent is the collector's name for the store's price event row.
type priceEvent = housingcrawl.PriceEvent

// markAbsent records that an active listing was not seen this COMPLETE sweep. See
// housingcrawl.MarkAbsent.
func markAbsent(ctx context.Context, tx pgx.Tx, pk int64, missed int16, delist bool) error {
	return housingcrawl.MarkAbsent(ctx, tx, pk, missed, delist)
}

// insertPriceEvent appends one price event. See housingcrawl.InsertPriceEvent.
func insertPriceEvent(ctx context.Context, tx pgx.Tx, ev priceEvent) error {
	return housingcrawl.InsertPriceEvent(ctx, tx, ev)
}

// linkListingSalCodes copies each listing's ABS sal_code from its region row. See
// housingcrawl.LinkListingSalCodes.
func linkListingSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return housingcrawl.LinkListingSalCodes(ctx, pool)
}

// linkPriceEventSalCodes copies each price event's ABS sal_code from its listing.
// See housingcrawl.LinkPriceEventSalCodes.
func linkPriceEventSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return housingcrawl.LinkPriceEventSalCodes(ctx, pool)
}
