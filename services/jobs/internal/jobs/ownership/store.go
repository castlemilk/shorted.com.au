package ownership

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgStore is the job's Postgres side.
type pgStore struct {
	db *pgxpool.Pool
}

// The headlines ASX gives a substantial holding notice. The leading ILIKE
// repeats idx_asx_ann_substantial's predicate so the planner can use it.
const substantialHeadlineSQL = `a.headline ILIKE '%substantial%'
  AND (a.headline ILIKE '%becoming a substantial holder%'
    OR a.headline ILIKE '%change in substantial holding%'
    OR a.headline ILIKE '%ceasing to be a substantial holder%'
    OR a.headline ILIKE '%change of interests of substantial%'
    OR a.headline ILIKE '%initial substantial holder%')`

// pendingNoticesSQL selects notices with no attempt, notices whose text could
// not be read or downloaded (again after 7 days, at most 3 times) and
// refusals from an older parser. Newest first, so a backlog never delays
// today's notices.
var pendingNoticesSQL = `
SELECT a.pdf_url,
       max(a.announcement_date)::text,
       (array_agg(a.headline ORDER BY a.announcement_date DESC, a.stock_code))[1],
       array_agg(DISTINCT a.stock_code::text)
FROM asx_announcements a
WHERE ` + substantialHeadlineSQL + `
  AND a.pdf_url IS NOT NULL AND a.pdf_url <> ''
  AND a.announcement_date >= $2::date
  AND NOT EXISTS (
    SELECT 1 FROM substantial_holder_notice_attempts t
    WHERE t.announcement_url = a.pdf_url
      AND NOT (t.outcome IN ('no_text', 'fetch_error') AND t.attempts < 3
               AND t.attempted_at < now() - interval '7 days')
      AND NOT (t.outcome NOT IN ('parsed', 'no_text', 'fetch_error') AND t.parser_version < $3))
GROUP BY a.pdf_url
ORDER BY max(a.announcement_date) DESC, a.pdf_url
LIMIT $1`

func (s *pgStore) PendingNotices(ctx context.Context, limit int, since string, parserVersion int) ([]pendingNotice, error) {
	rows, err := s.db.Query(ctx, pendingNoticesSQL, limit, since, parserVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pendingNotice
	for rows.Next() {
		var p pendingNotice
		if err := rows.Scan(&p.URL, &p.AnnouncedOn, &p.Headline, &p.ListedCodes); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *pgStore) Companies(ctx context.Context) (map[string]company, error) {
	rows, err := s.db.Query(ctx, `SELECT stock_code, company_name FROM "company-metadata"
		WHERE company_name IS NOT NULL AND company_name <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]company{}
	for rows.Next() {
		var c company
		if err := rows.Scan(&c.Code, &c.Name); err != nil {
			return nil, err
		}
		c.Code = strings.ToUpper(strings.TrimSpace(c.Code))
		out[c.Code] = c
	}
	return out, rows.Err()
}

// SharesOnIssue is a code's total product in issue from ASIC's short position
// report as at a date: the latest report on or before it (up to 45 days
// earlier, three days later for ASIC's lag). Zero when ASIC has none, which
// skips the check. Dated, because a consolidation or a scrip takeover changes
// the count: a notice from before one is checked against the count it was
// written against.
func (s *pgStore) SharesOnIssue(ctx context.Context, code, on string) (float64, error) {
	var issued float64
	err := s.db.QueryRow(ctx, `
		SELECT "TOTAL_PRODUCT_IN_ISSUE"
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		  AND "DATE" <= $2::date + 3 AND "DATE" >= $2::date - 45
		  AND "TOTAL_PRODUCT_IN_ISSUE" > 0
		ORDER BY "DATE" DESC
		LIMIT 1`, code, on).Scan(&issued)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return issued, err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *pgStore) UpsertNotice(ctx context.Context, r noticeRow) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key,
			institution_slug, event_date, announced_on, previous_pct, present_pct, previous_votes, present_votes,
			ceased, parser_version, parsed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, now())
		ON CONFLICT (announcement_url) DO UPDATE SET
			stock_code = EXCLUDED.stock_code, form = EXCLUDED.form, holder_name = EXCLUDED.holder_name,
			holder_key = EXCLUDED.holder_key, institution_slug = EXCLUDED.institution_slug,
			event_date = EXCLUDED.event_date, announced_on = EXCLUDED.announced_on,
			previous_pct = EXCLUDED.previous_pct, present_pct = EXCLUDED.present_pct,
			previous_votes = EXCLUDED.previous_votes, present_votes = EXCLUDED.present_votes,
			ceased = EXCLUDED.ceased, parser_version = EXCLUDED.parser_version, parsed_at = now()`,
		r.URL, r.StockCode, string(r.Form), nullIfEmpty(r.HolderName), r.HolderKey, nullIfEmpty(r.InstitutionSlug),
		nullIfEmpty(r.EventDate), r.AnnouncedOn, r.PreviousPct, r.PresentPct, r.PreviousVotes, r.PresentVotes,
		r.Ceased, noticeParserVersion)
	return err
}

func (s *pgStore) RecordAttempt(ctx context.Context, a noticeAttempt, parserVersion int) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version, attempts, attempted_at)
		VALUES ($1, $2, $3, $4, $5, 1, now())
		ON CONFLICT (announcement_url) DO UPDATE SET
			stock_code = EXCLUDED.stock_code, outcome = EXCLUDED.outcome, detail = EXCLUDED.detail,
			parser_version = EXCLUDED.parser_version,
			attempts = substantial_holder_notice_attempts.attempts + 1, attempted_at = now()`,
		a.URL, a.StockCode, a.Outcome, nullIfEmpty(truncate(a.Detail, 500)), parserVersion)
	return err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// SyncRegistry upserts the curated institutions. AUM columns belong to the
// funds mode and are never touched here.
func (s *pgStore) SyncRegistry(ctx context.Context, insts []Institution) (int, error) {
	batch := &pgx.Batch{}
	for _, in := range insts {
		batch.Queue(`
			INSERT INTO ownership_institutions (slug, name, kind, country, website, aliases, description, group_slug, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
			ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, country = EXCLUDED.country,
				website = EXCLUDED.website, aliases = EXCLUDED.aliases, description = EXCLUDED.description,
				group_slug = EXCLUDED.group_slug, updated_at = now()`,
			in.Slug, in.Name, string(in.Kind), nullIfEmpty(in.Country), nullIfEmpty(in.Website), in.Aliases,
			nullIfEmpty(in.Description), nullIfEmpty(in.Group))
	}
	br := s.db.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for i := range insts {
		if _, err := br.Exec(); err != nil {
			return i, fmt.Errorf("upsert institution %s: %w", insts[i].Slug, err)
		}
	}
	return len(insts), nil
}

// RelinkNotices re-resolves stored notices' holders after a registry or
// name-rule change (relinkHolder). Cheap (the name is stored), so it runs
// after every registry sync; the changes go in one batch.
func (s *pgStore) RelinkNotices(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `SELECT announcement_url, COALESCE(holder_name, ''), holder_key,
		COALESCE(institution_slug, '') FROM substantial_holder_notices`)
	if err != nil {
		return 0, err
	}
	batch := &pgx.Batch{}
	for rows.Next() {
		var url, name, key, slug string
		if err := rows.Scan(&url, &name, &key, &slug); err != nil {
			rows.Close()
			return 0, err
		}
		if n, k, sl, changed := relinkHolder(name, key, slug); changed {
			batch.Queue(`UPDATE substantial_holder_notices SET holder_name = $2, holder_key = $3, institution_slug = $4
				WHERE announcement_url = $1`, url, nullIfEmpty(n), k, nullIfEmpty(sl))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if batch.Len() == 0 {
		return 0, nil
	}
	if err := s.db.SendBatch(ctx, batch).Close(); err != nil {
		return 0, err
	}
	return batch.Len(), nil
}

// SaveSnapshot replaces one fund's holdings for one as-at date, in one
// transaction: a re-run of the same file rewrites it, never doubles it.
func (s *pgStore) SaveSnapshot(ctx context.Context, snap snapshot) (int, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total *float64
	for _, h := range snap.Holdings {
		total = addPtr(total, h.Value)
	}
	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO fund_holding_snapshots (institution_slug, fund_name, fund_code, source_kind, source_url, as_at,
			holdings_total, holdings_matched, value_total_aud, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, now())
		ON CONFLICT (institution_slug, fund_name, as_at) DO UPDATE SET
			fund_code = EXCLUDED.fund_code, source_kind = EXCLUDED.source_kind, source_url = EXCLUDED.source_url,
			holdings_total = EXCLUDED.holdings_total, holdings_matched = EXCLUDED.holdings_matched,
			value_total_aud = EXCLUDED.value_total_aud, fetched_at = now()
		RETURNING id`,
		snap.InstitutionSlug, snap.FundName, nullIfEmpty(snap.FundCode), snap.SourceKind, snap.SourceURL, snap.AsAt,
		snap.RowsTotal, len(snap.Holdings), total).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert snapshot: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fund_holdings WHERE snapshot_id = $1`, id); err != nil {
		return 0, err
	}
	rows := make([][]any, 0, len(snap.Holdings))
	for _, h := range snap.Holdings {
		rows = append(rows, []any{id, h.Code, nullIfEmpty(h.Name), h.Units, h.Value, h.Weight, h.Match})
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"fund_holdings"},
		[]string{"snapshot_id", "stock_code", "security_name", "units", "value_aud", "weight_pct", "match_method"},
		pgx.CopyFromRows(rows)); err != nil {
		return 0, fmt.Errorf("insert holdings: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// SaveIdentifiers records ISIN/SEDOL to code pairs. A pair seen again only
// refreshes seen_at; a code change (a renamed company keeps its ISIN) wins.
func (s *pgStore) SaveIdentifiers(ctx context.Context, ids map[string]identifier, source string) error {
	batch := &pgx.Batch{}
	for id, v := range ids {
		batch.Queue(`INSERT INTO security_identifiers (identifier, kind, stock_code, source, seen_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (identifier) DO UPDATE SET kind = EXCLUDED.kind, stock_code = EXCLUDED.stock_code,
				source = EXCLUDED.source, seen_at = now()`, id, v.Kind, v.Code, source)
	}
	br := s.db.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range ids {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (s *pgStore) Identifiers(ctx context.Context) (map[string]identifier, error) {
	rows, err := s.db.Query(ctx, `SELECT identifier, kind, stock_code FROM security_identifiers`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]identifier{}
	for rows.Next() {
		var id string
		var v identifier
		if err := rows.Scan(&id, &v.Kind, &v.Code); err != nil {
			return nil, err
		}
		out[id] = v
	}
	return out, rows.Err()
}

// SaveFunds upserts products, then sets each super fund institution's AUM
// to the total assets of the APRA funds it is trustee of.
func (s *pgStore) SaveFunds(ctx context.Context, funds []fundRow) error {
	batch := &pgx.Batch{}
	for _, f := range funds {
		batch.Queue(`INSERT INTO ownership_funds (fund_key, name, fund_type, asx_code, abn, manager_name,
				institution_slug, category, aum_aud, aum_as_at, source, source_url, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, now())
			ON CONFLICT (fund_key) DO UPDATE SET name = EXCLUDED.name, fund_type = EXCLUDED.fund_type,
				asx_code = EXCLUDED.asx_code, abn = EXCLUDED.abn, manager_name = EXCLUDED.manager_name,
				institution_slug = EXCLUDED.institution_slug, category = EXCLUDED.category,
				aum_aud = EXCLUDED.aum_aud, aum_as_at = EXCLUDED.aum_as_at, source = EXCLUDED.source,
				source_url = EXCLUDED.source_url, updated_at = now()`,
			f.Key, f.Name, f.Type, nullIfEmpty(f.ASXCode), nullIfEmpty(f.ABN), nullIfEmpty(f.Manager),
			nullIfEmpty(f.InstitutionSlug), nullIfEmpty(f.Category), f.AUM, nullIfEmpty(f.AsAt), f.Source, nullIfEmpty(f.SourceURL))
	}
	br := s.db.SendBatch(ctx, batch)
	for i := range funds {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return fmt.Errorf("upsert fund %s: %w", funds[i].Key, err)
		}
	}
	if err := br.Close(); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `
		UPDATE ownership_institutions i
		SET aum_aud = f.total, aum_as_at = f.as_at, aum_source = 'apra-fund-level', updated_at = now()
		FROM (SELECT institution_slug, sum(aum_aud) AS total, max(aum_as_at) AS as_at
		      FROM ownership_funds
		      WHERE fund_type = 'super_fund' AND institution_slug IS NOT NULL AND aum_aud IS NOT NULL
		      GROUP BY institution_slug) f
		WHERE i.slug = f.institution_slug`)
	return err
}
