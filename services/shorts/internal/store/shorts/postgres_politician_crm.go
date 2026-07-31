package shorts

// The per-politician CRM's read/write path. OPERATOR ONLY.
//
// EVERY READ HERE GOES THROUGH politician_profile_resolved, never
// politician_profile_facts. Reading the facts table directly would serve a value
// a curator has already corrected — which is the §8.17 failure exactly: fixed in
// two layers, still served from the third.
//
// EVERY WRITE IS APPEND-ONLY. A correction supersedes its predecessor rather
// than editing it, and a fact is suppressed rather than deleted, so the trail
// stays evidence rather than becoming a claim about what we once thought.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ProfileFactRow is one fact with its machine reading beside it.
type ProfileFactRow struct {
	Field         string
	Ordinal       int32
	ResolvedText  string
	MachineText   string
	IsCurated     bool
	CuratedBy     string
	SourceKey     string
	SourceURL     string
	SourceLicence string
}

type PoliticianTermRow struct {
	Parliament int32
	Chamber    string
	Division   string
	StateCode  string
	PartyAb    string
}

type DuplicateCandidateRow struct {
	Slug                string
	DisplayName         string
	StatementCount      int32
	DeclaredListedCount int32
	APHPHID             string
}

type PoliticianProfileSummaryRow struct {
	Slug                string
	DisplayName         string
	PartyAb             string
	Chamber             string
	Division            string
	StateCode           string
	APHPHID             string
	PhotoURL            string
	DeclaredListedCount int32
	StatementCount      int32
	HasDuplicate        bool
	CuratedFieldCount   int32
}

type PoliticianProfileRow struct {
	Summary        *PoliticianProfileSummaryRow
	Terms          []*PoliticianTermRow
	Facts          []*ProfileFactRow
	Duplicates     []*DuplicateCandidateRow
	PhotoURL       string
	PhotoLicence   string
	PhotoAuthor    string
	PhotoSourceURL string
}

// profileSummarySelect is shared by the list and the detail so the two can never
// disagree about what a summary is.
const profileSummarySelect = `
	SELECT p.slug, p.display_name,
	       COALESCE(t.party_ab, ''), COALESCE(t.chamber, ''),
	       COALESCE(t.division, ''), COALESCE(t.state_code, ''),
	       COALESCE(p.aph_phid, ''), COALESCE(p.photo_url, ''),
	       COALESCE(c.listed_count, 0),
	       COALESCE(st.statement_count, 0),
	       -- Another LIVE record sharing this PHID is the same human published
	       -- twice. Blank phids never count as duplicates of each other.
	       EXISTS (SELECT 1 FROM politicians d
	                WHERE d.id <> p.id AND d.merged_into_id IS NULL
	                  AND btrim(d.aph_phid) <> '' AND d.aph_phid = p.aph_phid),
	       COALESCE(cur.curated_count, 0)
	FROM politicians p
	LEFT JOIN LATERAL (
	    SELECT chamber, division, state_code, party_ab FROM politician_terms
	     WHERE politician_id = p.id ORDER BY parliament DESC LIMIT 1) t ON TRUE
	LEFT JOIN LATERAL (
	    SELECT count(DISTINCT stock_code) AS listed_count FROM mv_register_public_holdings
	     WHERE politician_id = p.id AND stock_code IS NOT NULL) c ON TRUE
	LEFT JOIN LATERAL (
	    SELECT count(*) AS statement_count FROM register_statements
	     WHERE politician_id = p.id) st ON TRUE
	LEFT JOIN LATERAL (
	    SELECT count(*) AS curated_count FROM politician_profile_overrides
	     WHERE politician_id = p.id AND superseded_by IS NULL) cur ON TRUE
	WHERE p.merged_into_id IS NULL`

func scanProfileSummary(scan func(...any) error) (*PoliticianProfileSummaryRow, error) {
	var r PoliticianProfileSummaryRow
	if err := scan(&r.Slug, &r.DisplayName, &r.PartyAb, &r.Chamber, &r.Division,
		&r.StateCode, &r.APHPHID, &r.PhotoURL, &r.DeclaredListedCount,
		&r.StatementCount, &r.HasDuplicate, &r.CuratedFieldCount); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListPoliticianProfiles backs the CRM index.
func (s *postgresStore) ListPoliticianProfiles(query string, limit, offset int32, duplicatesOnly bool) ([]*PoliticianProfileSummaryRow, int32, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if limit <= 0 || limit > 200 {
		limit = 50
	}

	sql := profileSummarySelect
	args := []any{limit, offset}
	if q := strings.TrimSpace(query); q != "" {
		sql += fmt.Sprintf(" AND (p.display_name ILIKE '%%' || $%d || '%%' OR p.slug ILIKE '%%' || $%d || '%%')",
			len(args)+1, len(args)+1)
		args = append(args, q)
	}
	if duplicatesOnly {
		sql += ` AND EXISTS (SELECT 1 FROM politicians d
		                      WHERE d.id <> p.id AND d.merged_into_id IS NULL
		                        AND btrim(d.aph_phid) <> '' AND d.aph_phid = p.aph_phid)`
	}
	// Duplicates first: they are wrong facts sitting in public, so they are the
	// work, not a filter someone has to remember to apply.
	sql += ` ORDER BY (EXISTS (SELECT 1 FROM politicians d
	                            WHERE d.id <> p.id AND d.merged_into_id IS NULL
	                              AND btrim(d.aph_phid) <> '' AND d.aph_phid = p.aph_phid)) DESC,
	                  p.display_name
	         LIMIT $1 OFFSET $2`

	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("list politician profiles: %w", err)
	}
	defer rows.Close()

	var out []*PoliticianProfileSummaryRow
	for rows.Next() {
		r, err := scanProfileSummary(rows.Scan)
		if err != nil {
			return nil, 0, 0, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, err
	}

	var total, dupes int32
	if err := s.db.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE EXISTS (
		         SELECT 1 FROM politicians d WHERE d.id <> p.id AND d.merged_into_id IS NULL
		           AND btrim(d.aph_phid) <> '' AND d.aph_phid = p.aph_phid))
		FROM politicians p WHERE p.merged_into_id IS NULL`).Scan(&total, &dupes); err != nil {
		return nil, 0, 0, err
	}
	return out, total, dupes, nil
}

// GetPoliticianProfile assembles one CRM record.
func (s *postgresStore) GetPoliticianProfile(slug string) (*PoliticianProfileRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	out := &PoliticianProfileRow{}
	summary, err := scanProfileSummary(s.db.QueryRow(ctx, profileSummarySelect+" AND p.slug = $1 LIMIT 1", slug).Scan)
	if err != nil {
		return nil, err
	}
	out.Summary = summary

	if err := s.db.QueryRow(ctx, `
		SELECT COALESCE(photo_url,''), COALESCE(photo_licence,''),
		       COALESCE(photo_author,''), COALESCE(photo_source_url,'')
		FROM politicians WHERE slug = $1`, slug).
		Scan(&out.PhotoURL, &out.PhotoLicence, &out.PhotoAuthor, &out.PhotoSourceURL); err != nil {
		return nil, err
	}
	// Same defence as the public read path: no licence, no image.
	if out.PhotoLicence == "" || out.PhotoSourceURL == "" {
		out.PhotoURL = ""
	}

	termRows, err := s.db.Query(ctx, `
		SELECT parliament, COALESCE(chamber,''), COALESCE(division,''),
		       COALESCE(state_code,''), COALESCE(party_ab,'')
		FROM politician_terms WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		ORDER BY parliament DESC`, slug)
	if err != nil {
		return nil, err
	}
	defer termRows.Close()
	for termRows.Next() {
		var t PoliticianTermRow
		if err := termRows.Scan(&t.Parliament, &t.Chamber, &t.Division, &t.StateCode, &t.PartyAb); err != nil {
			return nil, err
		}
		out.Terms = append(out.Terms, &t)
	}

	// THE RESOLVED VIEW, never the facts table.
	factRows, err := s.db.Query(ctx, `
		SELECT field, ordinal, resolved_text, COALESCE(machine_text,''), is_curated,
		       COALESCE(curated_by,''), source_key, source_url, source_licence
		FROM politician_profile_resolved
		WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		ORDER BY field, ordinal`, slug)
	if err != nil {
		return nil, err
	}
	defer factRows.Close()
	for factRows.Next() {
		var f ProfileFactRow
		if err := factRows.Scan(&f.Field, &f.Ordinal, &f.ResolvedText, &f.MachineText,
			&f.IsCurated, &f.CuratedBy, &f.SourceKey, &f.SourceURL, &f.SourceLicence); err != nil {
			return nil, err
		}
		out.Facts = append(out.Facts, &f)
	}

	dupRows, err := s.db.Query(ctx, `
		SELECT d.slug, d.display_name,
		       (SELECT count(*) FROM register_statements WHERE politician_id = d.id),
		       (SELECT count(DISTINCT stock_code) FROM mv_register_public_holdings
		         WHERE politician_id = d.id AND stock_code IS NOT NULL),
		       COALESCE(d.aph_phid,'')
		FROM politicians d
		WHERE d.merged_into_id IS NULL
		  AND btrim(d.aph_phid) <> ''
		  AND d.aph_phid = (SELECT aph_phid FROM politicians WHERE slug = $1)
		  AND d.slug <> $1`, slug)
	if err != nil {
		return nil, err
	}
	defer dupRows.Close()
	for dupRows.Next() {
		var d DuplicateCandidateRow
		if err := dupRows.Scan(&d.Slug, &d.DisplayName, &d.StatementCount,
			&d.DeclaredListedCount, &d.APHPHID); err != nil {
			return nil, err
		}
		out.Duplicates = append(out.Duplicates, &d)
	}

	return out, nil
}

var ErrCurationNeedsReason = errors.New("a rationale is required")

// CuratePoliticianFact records one human decision about one fact.
func (s *postgresStore) CuratePoliticianFact(slug, field string, ordinal int32, action, curatedText, rationale, evidenceURL, curator string) (*ProfileFactRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if strings.TrimSpace(rationale) == "" {
		return nil, ErrCurationNeedsReason
	}
	if strings.TrimSpace(curator) == "" {
		return nil, errors.New("curator identity is required")
	}
	switch action {
	case "amend", "suppress", "reinstate":
	default:
		return nil, fmt.Errorf("unknown action %q", action)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Freeze the machine reading AT THE MOMENT OF THE DECISION. Without it a
	// reviewer cannot tell later whether the crawl moved underneath them.
	var machineText string
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(fact_text,'') FROM politician_profile_facts
		WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		  AND field = $2 AND ordinal = $3 LIMIT 1`, slug, field, ordinal).Scan(&machineText)

	// Supersede rather than edit: the previous decision stays readable.
	if _, err := tx.Exec(ctx, `
		UPDATE politician_profile_overrides SET superseded_by = gen_random_uuid()
		WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		  AND field = $2 AND ordinal = $3 AND superseded_by IS NULL`, slug, field, ordinal); err != nil {
		return nil, fmt.Errorf("supersede prior override: %w", err)
	}

	// A reinstate is the absence of an override, so it writes nothing new.
	if action != "reinstate" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO politician_profile_overrides
				(politician_id, field, ordinal, action, machine_text, curated_text,
				 rationale, evidence_url, curated_by)
			SELECT p.id, $2, $3, $4, $5, $6, $7, $8, $9 FROM politicians p WHERE p.slug = $1`,
			slug, field, ordinal, action, machineText, strings.TrimSpace(curatedText),
			strings.TrimSpace(rationale), strings.TrimSpace(evidenceURL), curator); err != nil {
			return nil, fmt.Errorf("record override: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	var f ProfileFactRow
	if err := s.db.QueryRow(ctx, `
		SELECT field, ordinal, resolved_text, COALESCE(machine_text,''), is_curated,
		       COALESCE(curated_by,''), source_key, source_url, source_licence
		FROM politician_profile_resolved
		WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		  AND field = $2 AND ordinal = $3`, slug, field, ordinal).
		Scan(&f.Field, &f.Ordinal, &f.ResolvedText, &f.MachineText, &f.IsCurated,
			&f.CuratedBy, &f.SourceKey, &f.SourceURL, &f.SourceLicence); err != nil {
		// A suppressed fact leaves the view entirely; that is success, not an error.
		return &ProfileFactRow{Field: field, Ordinal: ordinal, MachineText: machineText}, nil
	}
	return &f, nil
}

var ErrPhotoNeedsAttribution = errors.New("a photo requires a licence and a source URL")

// SetPoliticianPhoto replaces or clears a portrait.
func (s *postgresStore) SetPoliticianPhoto(slug, url, licence, author, sourceURL, curator string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	url = strings.TrimSpace(url)
	licence = strings.TrimSpace(licence)
	sourceURL = strings.TrimSpace(sourceURL)

	// Refuse here as well as at the CHECK. The constraint is the backstop; this
	// is the message a curator can act on, and it states the rule rather than
	// surfacing a constraint name.
	if url != "" && (licence == "" || sourceURL == "") {
		return ErrPhotoNeedsAttribution
	}
	if strings.TrimSpace(curator) == "" {
		return errors.New("curator identity is required")
	}

	_, err := s.db.Exec(ctx, `
		UPDATE politicians
		SET photo_url = $2, photo_licence = $3, photo_author = $4,
		    photo_source_url = $5, photo_fetched_at = now()
		WHERE slug = $1`, slug, url, licence, strings.TrimSpace(author), sourceURL)
	if err != nil {
		return fmt.Errorf("set portrait: %w", err)
	}
	return nil
}

var ErrMergeNeedsEvidence = errors.New("a merge requires evidence")

// MergePoliticians folds one record into another.
//
// THE LOSER'S SLUG IS NOT DELETED. Slugs are minted once and never reassigned
// (§3.3) because they reach OG images, the sitemap and editorial cross-links —
// so the merged-away row is retained with merged_into_id set, and the read path
// resolves its slug to the survivor as a redirect.
func (s *postgresStore) MergePoliticians(keepSlug, mergeSlug, evidence, curator string) (int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if strings.TrimSpace(evidence) == "" {
		return 0, ErrMergeNeedsEvidence
	}
	if strings.TrimSpace(curator) == "" {
		return 0, errors.New("curator identity is required")
	}
	if keepSlug == mergeSlug {
		return 0, errors.New("cannot merge a record into itself")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var keepID, mergeID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM politicians WHERE slug = $1 AND merged_into_id IS NULL`, keepSlug).Scan(&keepID); err != nil {
		return 0, fmt.Errorf("surviving record %q not found or already merged: %w", keepSlug, err)
	}
	if err := tx.QueryRow(ctx, `SELECT id::text FROM politicians WHERE slug = $1 AND merged_into_id IS NULL`, mergeSlug).Scan(&mergeID); err != nil {
		return 0, fmt.Errorf("record %q not found or already merged: %w", mergeSlug, err)
	}

	// Move the declared history. This is the part that makes a merge
	// irreversible in practice, and why evidence is mandatory.
	tag, err := tx.Exec(ctx,
		`UPDATE register_statements SET politician_id = $1 WHERE politician_id = $2`, keepID, mergeID)
	if err != nil {
		return 0, fmt.Errorf("move statements: %w", err)
	}
	moved := int32(tag.RowsAffected())

	if _, err := tx.Exec(ctx,
		`UPDATE register_declared_items SET politician_id = $1 WHERE politician_id = $2`, keepID, mergeID); err != nil {
		return 0, fmt.Errorf("move declared items: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE politicians
		SET merged_into_id = $1, merged_by = $3, merged_at = now(), merge_evidence = $4
		WHERE id = $2`, keepID, mergeID, curator, strings.TrimSpace(evidence)); err != nil {
		return 0, fmt.Errorf("record merge: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return moved, nil
}
