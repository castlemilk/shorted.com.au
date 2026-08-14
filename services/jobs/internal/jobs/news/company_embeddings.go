package news

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	similarTopK = 6 // nearest neighbours per anchor company
)

// CompanyEmbedOpts controls the embed-company-summaries run.
type CompanyEmbedOpts struct {
	// Limit caps the number of company summaries embedded this run (0 = all).
	Limit int
}

// EmbedCompanySummaries selects company-metadata rows that have an
// enhanced_summary but no company_summary embedding yet, embeds them via
// Gemini, and writes the vectors to the embeddings table.
//
// Returns the number of embeddings written.
func EmbedCompanySummaries(ctx context.Context, db *pgxpool.Pool, embedder *Embedder, opts CompanyEmbedOpts) (int, error) {
	query := `
		SELECT cm.stock_code,
		       cm.enhanced_summary,
		       COALESCE(cm.company_history, '')
		FROM "company-metadata" cm
		WHERE cm.enhanced_summary IS NOT NULL
		  AND cm.enhanced_summary <> ''
		  AND NOT EXISTS (
		      SELECT 1 FROM embeddings e
		      WHERE e.object_type = 'company_summary'
		        AND e.object_id   = cm.stock_code
		  )
		ORDER BY cm.stock_code`
	if opts.Limit > 0 {
		query += fmt.Sprintf(" LIMIT %d", opts.Limit)
	}

	rows, err := db.Query(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("select unembedded company summaries: %w", err)
	}

	var codes, texts []string
	for rows.Next() {
		var code, summary, history string
		if err := rows.Scan(&code, &summary, &history); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan company-metadata: %w", err)
		}
		codes = append(codes, code)
		text := strings.TrimSpace(summary)
		if h := strings.TrimSpace(history); h != "" {
			text += "\n\n" + h
		}
		texts = append(texts, text)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate company-metadata: %w", err)
	}
	if len(codes) == 0 {
		return 0, nil
	}

	log.Printf("embed-company-summaries: %d companies to embed", len(codes))

	written := 0
	// Process in chunks matching embedBatchSize so the concurrency fan-out
	// stays bounded the same way as EmbedBackfill.
	for start := 0; start < len(codes); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(codes) {
			end = len(codes)
		}
		batchCodes := codes[start:end]
		batchTexts := texts[start:end]

		vectors, err := embedder.EmbedBatch(ctx, batchTexts)
		if err != nil {
			return written, fmt.Errorf("EmbedBatch (chunk %d): %w", start/embedBatchSize, err)
		}

		for i, code := range batchCodes {
			if vectors[i] == nil {
				log.Printf("  WARN: embedding nil for %s; will retry on next run", code)
				continue
			}
			_, err := db.Exec(ctx, `
				INSERT INTO embeddings (object_type, object_id, chunk_idx, embedding, model)
				VALUES ('company_summary', $1, 0, $2::vector, $3)
				ON CONFLICT (object_type, object_id, chunk_idx)
				DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`,
				code, formatVector(vectors[i]), embeddingModel)
			if err != nil {
				log.Printf("  WARN: failed to write embedding for %s: %v", code, err)
				continue
			}
			written++
		}
		log.Printf("  chunk %d-%d: %d/%d written", start, end-1, written, end)
	}

	if failed := len(codes) - written; failed > 0 {
		log.Printf("  WARN: %d/%d company embeddings failed (will retry)", failed, len(codes))
	}
	return written, nil
}

// ComputeSimilarCompanies iterates over every company_summary embedding,
// finds the top-K nearest OTHER company_summary vectors using the HNSW index
// (by passing the anchor embedding as a $1::vector literal — never a CROSS
// JOIN or correlated subquery), and writes/updates similar_to edges in
// entity_edges.
//
// Returns the number of edges written.
func ComputeSimilarCompanies(ctx context.Context, db *pgxpool.Pool) (int, error) {
	// Fetch all (stock_code, embedding text literal) pairs that also have a
	// company entity.  We cast embedding to text here so the Go driver sends it
	// as a plain string; the similarity query re-casts it as $1::vector which
	// lets pgvector use the HNSW index.
	anchorRows, err := db.Query(ctx, `
		SELECT e.object_id, e.embedding::text, ent.id
		FROM embeddings e
		JOIN entities ent ON ent.stock_code = e.object_id AND ent.type = 'company'
		WHERE e.object_type = 'company_summary'
		ORDER BY e.object_id`)
	if err != nil {
		return 0, fmt.Errorf("select anchor embeddings: %w", err)
	}

	type anchor struct {
		stockCode    string
		embeddingTxt string
		entityID     int64
	}
	var anchors []anchor
	for anchorRows.Next() {
		var a anchor
		if err := anchorRows.Scan(&a.stockCode, &a.embeddingTxt, &a.entityID); err != nil {
			anchorRows.Close()
			return 0, fmt.Errorf("scan anchor: %w", err)
		}
		anchors = append(anchors, a)
	}
	anchorRows.Close()
	if err := anchorRows.Err(); err != nil {
		return 0, fmt.Errorf("iterate anchors: %w", err)
	}
	if len(anchors) == 0 {
		log.Printf("compute-similar-companies: no company_summary embeddings with matching entities found")
		return 0, nil
	}

	log.Printf("compute-similar-companies: computing top-%d neighbours for %d companies", similarTopK, len(anchors))

	// Build a stock_code→entity_id lookup from the anchors we already fetched.
	entityIDByCode := make(map[string]int64, len(anchors))
	for _, a := range anchors {
		entityIDByCode[a.stockCode] = a.entityID
	}

	written := 0
	for _, a := range anchors {
		// Pass the anchor embedding as a $1::vector LITERAL so pgvector can
		// use the HNSW index on the embeddings table.  A CROSS JOIN or
		// correlated subquery would force a full sequential scan.
		nbrRows, err := db.Query(ctx, `
			SELECT e.object_id,
			       (e.embedding <=> $1::vector) AS dist
			FROM   embeddings e
			WHERE  e.object_type = 'company_summary'
			  AND  e.object_id  <> $2
			ORDER  BY e.embedding <=> $1::vector
			LIMIT  $3`,
			a.embeddingTxt, a.stockCode, similarTopK)
		if err != nil {
			log.Printf("  WARN: neighbour query failed for %s: %v", a.stockCode, err)
			continue
		}

		type neighbour struct {
			stockCode string
			dist      float64
		}
		var nbrs []neighbour
		for nbrRows.Next() {
			var n neighbour
			if err := nbrRows.Scan(&n.stockCode, &n.dist); err != nil {
				nbrRows.Close()
				log.Printf("  WARN: scan neighbour for %s: %v", a.stockCode, err)
				break
			}
			nbrs = append(nbrs, n)
		}
		nbrRows.Close()
		if err := nbrRows.Err(); err != nil {
			log.Printf("  WARN: iterate neighbours for %s: %v", a.stockCode, err)
			continue
		}

		for _, nbr := range nbrs {
			dstID, ok := entityIDByCode[nbr.stockCode]
			if !ok {
				// The neighbour has an embedding but no company entity — skip.
				continue
			}
			weight := 1.0 - nbr.dist // cosine similarity (dist is cosine distance)
			_, err := db.Exec(ctx, `
				INSERT INTO entity_edges (src_id, dst_id, edge_type, weight, attrs, source)
				VALUES ($1, $2, 'similar_to', $3, '{}', 'narrative_sim')
				ON CONFLICT (src_id, dst_id, edge_type)
				DO UPDATE SET weight = EXCLUDED.weight`,
				a.entityID, dstID, weight)
			if err != nil {
				log.Printf("  WARN: failed to write edge %s→%s: %v", a.stockCode, nbr.stockCode, err)
				continue
			}
			written++
		}
	}

	log.Printf("compute-similar-companies: %d similar_to edges written", written)
	return written, nil
}
