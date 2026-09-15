package influence

// Manifest persistence for the register crawl.
//
// register_documents IS the crawl cursor: resumability and idempotence come
// from its fetch/classify/extract status columns, not from a separate runs
// table. Discovery therefore upserts listing metadata and must not reset work
// already done.
//
// ONE exception, and it is narrow: a 'fetched' row returns to 'pending' when its
// own listing says the document changed since we fetched it (see
// upsertRegisterDocuments). That is not resetting done work — the work was done
// on a file APH has since replaced. Nothing else moves: 'blocked' and 'failed'
// keep their state, and classify/extract status is never touched here (a changed
// file resets classification in markDocumentFetched, only when its bytes differ).

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

// upsertRegisterDocuments idempotently writes the listing into the manifest.
//
// ON CONFLICT updates listing metadata. classify_status, extract_status,
// content_sha256 and storage_uri are deliberately absent from the SET list;
// fetch_status/fetch_attempts appear only in the re-queue CASE below.
//
// listedAt is the discover run's own clock, stamped on every row this listing
// carries. A row whose last_listed_at is older than the newest one has left its
// listing page — which is how recordHouseSuccession finds the documents APH
// replaced.
//
// # Re-queue on update
//
// A fetched document goes back to 'pending' when its listing date is on or after
// the day we fetched it. Before this, nothing ever re-queued a fetched row:
// last_updated_at was written and never read, so a member who amended their
// register at the same URL was never re-fetched, and the corpus silently froze
// at its first crawl (57 of 151 current members were stale by 2026-09-15).
//
// ON OR AFTER, in Sydney time, because the listing is a local date and fetched_at
// is a UTC instant. An amendment posted later on the day we fetched would be
// missed by a strict "after"; the cost of ">=" is at most one extra fetch of an
// unchanged file, which fetch records as byte-identical and which keeps its
// classification (markDocumentFetched only resets that on a content change).
func upsertRegisterDocuments(ctx context.Context, pool *pgxpool.Pool, docs []RegisterDocument, listedAt time.Time) (int, error) {
	const q = `
		INSERT INTO register_documents
			(source_url, listing_url, chamber, parliament, member_hint, division_hint,
			 state_hint, last_updated_at, listed_size_label, volume_label,
			 volume_ordinal, tabled_from, tabled_to, statements_only,
			 source, source_licence, last_listed_at, discovered_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
		ON CONFLICT (source_url) DO UPDATE SET
			fetch_status = CASE
				WHEN register_documents.fetch_status = 'fetched'
				 AND EXCLUDED.last_updated_at IS NOT NULL
				 AND register_documents.fetched_at IS NOT NULL
				 AND EXCLUDED.last_updated_at >= (register_documents.fetched_at AT TIME ZONE 'Australia/Sydney')::date
				THEN 'pending' ELSE register_documents.fetch_status END,
			fetch_attempts = CASE
				WHEN register_documents.fetch_status = 'fetched'
				 AND EXCLUDED.last_updated_at IS NOT NULL
				 AND register_documents.fetched_at IS NOT NULL
				 AND EXCLUDED.last_updated_at >= (register_documents.fetched_at AT TIME ZONE 'Australia/Sydney')::date
				THEN 0 ELSE register_documents.fetch_attempts END,
			last_listed_at    = EXCLUDED.last_listed_at,
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
				listedAt,
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
