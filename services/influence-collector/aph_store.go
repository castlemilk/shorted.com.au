package main

// Manifest persistence for the register crawl.
//
// register_documents IS the crawl cursor: resumability and idempotence come
// from its fetch/classify/extract status columns, not from a separate runs
// table. Discovery therefore upserts ONLY listing metadata and must never touch
// a status column, or a re-discover would silently reset work already done.

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// registerUpsertChunk bounds each pgx.Batch. A single batch containing every
// statement pipelines them all in one round-trip, which STALLS through
// Supabase's PgBouncer transaction pooler (observed in house-price-collector's
// crime ingest, hanging at 0 rows). 775 rows fits comfortably in one chunk, but
// the bound keeps the shape correct if the corpus grows.
const registerUpsertChunk = 500

// upsertRegisterDocuments idempotently writes the discovered manifest.
//
// ON CONFLICT updates listing metadata only. fetch_status, classify_status,
// extract_status, content_sha256 and storage_uri are deliberately absent from
// the SET list.
func upsertRegisterDocuments(ctx context.Context, pool *pgxpool.Pool, docs []RegisterDocument) (int, error) {
	const q = `
		INSERT INTO register_documents
			(source_url, listing_url, chamber, parliament, member_hint, division_hint,
			 state_hint, last_updated_at, listed_size_label, volume_label,
			 volume_ordinal, tabled_from, tabled_to, statements_only,
			 source, source_licence)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		ON CONFLICT (source_url) DO UPDATE SET
			listing_url       = EXCLUDED.listing_url,
			chamber           = EXCLUDED.chamber,
			parliament        = EXCLUDED.parliament,
			member_hint       = EXCLUDED.member_hint,
			division_hint     = EXCLUDED.division_hint,
			state_hint        = EXCLUDED.state_hint,
			last_updated_at   = EXCLUDED.last_updated_at,
			listed_size_label = EXCLUDED.listed_size_label,
			volume_label      = EXCLUDED.volume_label,
			volume_ordinal    = EXCLUDED.volume_ordinal,
			tabled_from       = EXCLUDED.tabled_from,
			tabled_to         = EXCLUDED.tabled_to,
			statements_only   = EXCLUDED.statements_only,
			updated_at        = now()`

	written := 0
	for start := 0; start < len(docs); start += registerUpsertChunk {
		chunk := docs[start:min(start+registerUpsertChunk, len(docs))]

		batch := &pgx.Batch{}
		for _, d := range chunk {
			batch.Queue(q,
				d.SourceURL,
				d.ListingURL,
				d.Chamber,
				nullableInt(d.Parliament),
				d.MemberHint,
				d.DivisionHint,
				d.StateHint,
				nullableTime(d.LastUpdatedAt),
				d.ListedSizeLabel,
				d.VolumeLabel,
				nullableInt(d.VolumeOrdinal),
				nullableTime(d.TabledFrom),
				nullableTime(d.TabledTo),
				d.StatementsOnly,
				registerSource,
				registerSourceLicence,
			)
		}

		br := pool.SendBatch(ctx, batch)
		for range chunk {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return written, fmt.Errorf("upsert register document: %w", err)
			}
			written++
		}
		if err := br.Close(); err != nil {
			return written, err
		}
	}
	return written, nil
}

// registerManifestCounts summarises the manifest for run metadata and logging.
type registerManifestCounts struct {
	Total         int
	House         int
	Senate        int
	ByParliament  map[int]int
	PendingFetch  int
	BlockedFetch  int
	PendingExtrct int
}

func countRegisterDocuments(ctx context.Context, pool *pgxpool.Pool) (registerManifestCounts, error) {
	out := registerManifestCounts{ByParliament: map[int]int{}}

	rows, err := pool.Query(ctx, `
		SELECT chamber, COALESCE(parliament, 0), count(*)
		FROM register_documents
		GROUP BY 1, 2`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var chamber string
		var parliament, n int
		if err := rows.Scan(&chamber, &parliament, &n); err != nil {
			return out, err
		}
		out.Total += n
		switch chamber {
		case "house":
			out.House += n
			out.ByParliament[parliament] += n
		case "senate":
			out.Senate += n
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	err = pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE fetch_status = 'pending'),
			count(*) FILTER (WHERE fetch_status = 'blocked'),
			count(*) FILTER (WHERE extract_status = 'pending')
		FROM register_documents`).
		Scan(&out.PendingFetch, &out.BlockedFetch, &out.PendingExtrct)
	return out, err
}

func nullableInt(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}
