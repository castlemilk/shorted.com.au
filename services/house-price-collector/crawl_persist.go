package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// persistRunRecord writes the round's health record. The db and shadow sinks write
// crawl_run_status as before. The ingest sink has no database, so it sends the same
// record as a counts-only ReportCycle instead.
func persistRunRecord(ctx context.Context, pool *pgxpool.Pool, rec crawlRunStatusRecord, exitCode int) {
	if ir := ingestRoundFrom(ctx); ir != nil && ir.mode == crawlSinkIngest {
		ir.reportCycle(rec, exitCode)
		return
	}
	writeCrawlRunStatus(rec, pool)
}
