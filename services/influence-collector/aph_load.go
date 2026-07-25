package main

// Loads extraction artifacts into the normalised tables.
//
// The Python tier owns PDF -> JSON; this owns JSON -> rows and identity. They
// meet at register_extractions.payload, which means re-normalising costs no
// Gemini calls and no APH traffic when these rules change — and they will churn
// far more than the parser does.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// registerArtifact mirrors register_schema.py. The contract between the two
// languages is this one JSON shape.
type registerArtifact struct {
	SchemaVersion string              `json:"schema_version"`
	DocumentSHA   string              `json:"document_sha256"`
	SourceURL     string              `json:"source_url"`
	Chamber       string              `json:"chamber"`
	Parliament    int                 `json:"parliament"`
	Statements    []artifactStatement `json:"statements"`
	Warnings      []string            `json:"warnings"`
}

type artifactStatement struct {
	Ordinal      int            `json:"ordinal"`
	Kind         string         `json:"kind"`
	LodgedDate   *string        `json:"lodged_date"`
	DateIsStated bool           `json:"date_is_stated"`
	PageFrom     int            `json:"page_from"`
	PageTo       int            `json:"page_to"`
	Items        []artifactItem `json:"items"`
}

type artifactItem struct {
	ItemNo    int           `json:"item_no"`
	ItemLabel string        `json:"item_label"`
	PageNo    int           `json:"page_no"`
	Rows      []artifactRow `json:"rows"`
}

type artifactRow struct {
	Holder         string   `json:"holder"`
	ChangeType     string   `json:"change_type"`
	Ordinal        int      `json:"ordinal"`
	DeclaredText   string   `json:"declared_text"`
	DeclaredLines  []string `json:"declared_lines"`
	SecondaryText  string   `json:"secondary_text"`
	TertiaryText   string   `json:"tertiary_text"`
	IsNil          bool     `json:"is_nil"`
	ContainsAmount bool     `json:"contains_amount"`
	PageNo         int      `json:"page_no"`
}

// pendingExtraction is one artifact awaiting load, with the manifest context
// needed to resolve who it belongs to.
type pendingExtraction struct {
	ExtractionID string
	DocumentID   string
	SourceURL    string
	Chamber      string
	Parliament   int
	MemberHint   string
	DivisionHint string
	StateHint    string
	Payload      []byte
}

// selectExtractionsToLoad returns the newest artifact per document.
//
// 'partial' documents are excluded: a document whose pages are mostly
// unattributed is indistinguishable from a member who declared nothing, and
// letting it through would publish silence as a fact.
func selectExtractionsToLoad(ctx context.Context, pool *pgxpool.Pool, limit int) ([]pendingExtraction, error) {
	q := `
		SELECT DISTINCT ON (e.document_id)
		       e.id::text, e.document_id::text, d.source_url, d.chamber,
		       COALESCE(d.parliament, 0), d.member_hint, d.division_hint,
		       d.state_hint, e.payload
		FROM register_extractions e
		JOIN register_documents d ON d.id = e.document_id
		WHERE d.extract_status = 'extracted'
		ORDER BY e.document_id, e.created_at DESC`
	if limit > 0 {
		q = fmt.Sprintf("SELECT * FROM (%s) x LIMIT %d", q, limit)
	}

	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []pendingExtraction
	for rows.Next() {
		var p pendingExtraction
		if err := rows.Scan(&p.ExtractionID, &p.DocumentID, &p.SourceURL, &p.Chamber,
			&p.Parliament, &p.MemberHint, &p.DivisionHint, &p.StateHint, &p.Payload); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// resolvePolitician finds or creates the person a document belongs to, and
// records their term in that parliament.
//
// Slugs are minted once. An existing person keeps the slug they already have —
// it is already in URLs, OG images and the sitemap.
func resolvePolitician(ctx context.Context, tx pgx.Tx, id PersonIdentity, stateHint, divisionHint, sourceURL string, parliament int, chamber string) (string, error) {
	if id.PersonKey == "" {
		return "", fmt.Errorf("unresolvable identity")
	}

	var politicianID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM politicians WHERE person_key = $1`, id.PersonKey).Scan(&politicianID)
	if err != nil && err != pgx.ErrNoRows {
		return "", err
	}

	if politicianID == "" {
		slug, serr := mintSlug(ctx, tx, id, stateHint)
		if serr != nil {
			return "", serr
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO politicians
				(person_key, surname, given_names, display_name, honorific, slug,
				 first_parliament, last_parliament, source_url)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
			RETURNING id::text`,
			id.PersonKey, id.Surname, id.GivenNames, id.DisplayName, id.Honorific,
			slug, parliament, sourceURL).Scan(&politicianID); err != nil {
			return "", err
		}
	} else {
		// Widen the served range; never touch the slug.
		if _, err := tx.Exec(ctx, `
			UPDATE politicians SET
				first_parliament = LEAST(COALESCE(first_parliament, $2), $2),
				last_parliament  = GREATEST(COALESCE(last_parliament, $2), $2),
				display_name     = CASE WHEN $3 <> '' THEN $3 ELSE display_name END,
				updated_at       = now()
			WHERE id = $1`, politicianID, parliament, id.DisplayName); err != nil {
			return "", err
		}
	}

	// Observed spellings are recorded for audit and for later manual merges.
	if _, err := tx.Exec(ctx, `
		INSERT INTO politician_aliases (alias_key, politician_id, alias_raw, alias_kind)
		VALUES ($1, $2, $3, 'observed')
		ON CONFLICT (alias_key) DO NOTHING`,
		id.PersonKey, politicianID, id.DisplayName); err != nil {
		return "", err
	}

	if parliament > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO politician_terms
				(politician_id, parliament, chamber, division, state_code, source_url)
			VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6)
			ON CONFLICT (politician_id, parliament, chamber) DO UPDATE SET
				division   = COALESCE(NULLIF(EXCLUDED.division, ''), politician_terms.division),
				state_code = COALESCE(NULLIF(EXCLUDED.state_code, ''), politician_terms.state_code)`,
			politicianID, parliament, chamber, divisionHint, stateHint, sourceURL); err != nil {
			return "", err
		}
	}

	return politicianID, nil
}

func mintSlug(ctx context.Context, tx pgx.Tx, id PersonIdentity, stateHint string) (string, error) {
	for _, candidate := range slugCandidates(id, stateHint) {
		if candidate == "" {
			continue
		}
		var taken bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM politicians WHERE slug = $1)`, candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no free slug for %q", id.DisplayName)
}

// loadExtraction writes one artifact's statements and items in a single
// transaction, so a document is either wholly loaded or not at all.
func loadExtraction(ctx context.Context, pool *pgxpool.Pool, p pendingExtraction) (statements, items int, err error) {
	var artifact registerArtifact
	if err := json.Unmarshal(p.Payload, &artifact); err != nil {
		return 0, 0, fmt.Errorf("decode artifact: %w", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	identity := parseMemberHint(p.MemberHint)
	politicianID := ""
	identityStatus := "unresolved"
	if identity.PersonKey != "" {
		politicianID, err = resolvePolitician(ctx, tx, identity, p.StateHint, p.DivisionHint, p.SourceURL, p.Parliament, p.Chamber)
		if err != nil {
			return 0, 0, err
		}
		identityStatus = "resolved"
	}

	// Reloading a document replaces its rows rather than duplicating them; the
	// cascade clears the items.
	if _, err := tx.Exec(ctx, `DELETE FROM register_statements WHERE document_id = $1`, p.DocumentID); err != nil {
		return 0, 0, err
	}

	for _, s := range artifact.Statements {
		var lodged *time.Time
		if s.LodgedDate != nil && *s.LodgedDate != "" {
			if t, perr := time.Parse("2006-01-02", *s.LodgedDate); perr == nil {
				lodged = &t
			}
		}

		var statementID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO register_statements
				(document_id, extraction_id, politician_id, statement_ordinal,
				 statement_kind, chamber, parliament, declared_surname,
				 declared_other_names, declared_division, declared_state,
				 lodged_date, date_is_stated, page_from, page_to,
				 identity_status, source_url)
			VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, NULLIF($7, 0), $8, $9,
			        $10, $11, $12, $13, $14, $15, $16, $17)
			RETURNING id::text`,
			p.DocumentID, p.ExtractionID, politicianID, s.Ordinal, s.Kind, p.Chamber,
			p.Parliament, identity.Surname, identity.GivenNames, p.DivisionHint,
			p.StateHint, lodged, s.DateIsStated, s.PageFrom, s.PageTo,
			identityStatus, p.SourceURL).Scan(&statementID); err != nil {
			return 0, 0, fmt.Errorf("insert statement %d: %w", s.Ordinal, err)
		}
		statements++

		batch := &pgx.Batch{}
		queued := 0
		for _, item := range s.Items {
			for _, r := range item.Rows {
				lines := r.DeclaredLines
				if lines == nil {
					lines = []string{}
				}
				batch.Queue(`
					INSERT INTO register_declared_items
						(statement_id, politician_id, item_no, item_label, holder,
						 change_type, row_ordinal, declared_text, declared_lines,
						 secondary_text, tertiary_text, is_nil, page_no,
						 extraction_id, contains_amount, source_url)
					VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5, $6, $7, $8, $9,
					        $10, $11, $12, NULLIF($13, 0), $14, $15, $16)
					ON CONFLICT (statement_id, item_no, holder, change_type, row_ordinal)
					DO NOTHING`,
					statementID, politicianID, item.ItemNo, item.ItemLabel, r.Holder,
					r.ChangeType, r.Ordinal, r.DeclaredText, lines, r.SecondaryText,
					r.TertiaryText, r.IsNil, r.PageNo, p.ExtractionID, r.ContainsAmount,
					p.SourceURL)
				queued++
			}
		}
		if queued > 0 {
			br := tx.SendBatch(ctx, batch)
			for range queued {
				if _, err := br.Exec(); err != nil {
					_ = br.Close()
					return 0, 0, fmt.Errorf("insert declared item: %w", err)
				}
				items++
			}
			if err := br.Close(); err != nil {
				return 0, 0, err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return statements, items, nil
}

// purgeNonExtractedStatements removes rows belonging to documents that are no
// longer 'extracted'.
//
// Load alone is not enough: when a re-extract DOWNGRADES a document to 'partial'
// (a coverage miss, or a layout this parser cannot attribute), its previously
// loaded rows would otherwise stay in the tables and keep being published. The
// quarantine has to be retroactive or it is not a quarantine.
func purgeNonExtractedStatements(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `
		DELETE FROM register_statements s
		USING register_documents d
		WHERE d.id = s.document_id
		  AND d.extract_status <> 'extracted'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// registerLoadStats summarises what the tables now hold.
type registerLoadStats struct {
	Politicians int
	Statements  int
	Items       int
	Declared    int
	Unresolved  int
}

func registerLoadSummary(ctx context.Context, pool *pgxpool.Pool) (registerLoadStats, error) {
	var s registerLoadStats
	err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM politicians),
		       (SELECT count(*) FROM register_statements),
		       (SELECT count(*) FROM register_declared_items),
		       (SELECT count(*) FROM register_declared_items WHERE NOT is_nil),
		       (SELECT count(*) FROM register_statements WHERE identity_status <> 'resolved')`).
		Scan(&s.Politicians, &s.Statements, &s.Items, &s.Declared, &s.Unresolved)
	return s, err
}
