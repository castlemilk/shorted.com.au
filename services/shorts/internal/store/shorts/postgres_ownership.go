package shorts

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Ownership read path (migration 000137, filled by `shorted ownership`).
//
// Prod does not run `migrate up`, so the API can be deployed against a
// database without the ownership tables: every read treats a missing table or
// column as no data (logged once per method), never a 500. Aggregation is not
// done here; these return row sets and services/shorts/ownership.go builds
// the views from them.

// OwnershipStore is the ownership read surface. Implemented by the Postgres
// store; the server finds it by type assertion, so a store without it serves
// empty ownership responses.
type OwnershipStore interface {
	OwnershipInstitutions(ctx context.Context) ([]OwnershipInstitutionRow, error)
	CurrentSubstantialHoldings(ctx context.Context, filter OwnershipFilter) ([]SubstantialHoldingRow, error)
	SubstantialNotices(ctx context.Context, filter OwnershipFilter, limit int) ([]SubstantialNoticeRow, error)
	NoticeStats(ctx context.Context) (*NoticeStats, error)
	LatestFundHoldings(ctx context.Context, filter OwnershipFilter) ([]FundHoldingRow, error)
	OwnershipFunds(ctx context.Context, institutionSlug string) ([]OwnershipFundRow, error)
	LatestShortPositions(ctx context.Context) (map[string]ShortPosition, error)
	OwnershipCompanies(ctx context.Context) (map[string]OwnershipCompany, error)
}

// OwnershipFilter narrows a read to one stock or one holder; empty fields do
// not filter.
type OwnershipFilter struct {
	StockCode       string
	HolderKey       string
	InstitutionSlug string
}

type OwnershipInstitutionRow struct {
	Slug, Name, Kind, Country, Website, Description string
	// Group is the institution whose notices include this one's interests.
	Group   string
	AUM     *float64
	AUMAsAt string
}

// SubstantialHoldingRow is a holder's latest notice in a stock that leaves it
// substantial (v_substantial_holdings_current). Kind is the institution's
// kind, "corporate" for a listed company, else "unclassified".
type SubstantialHoldingRow struct {
	StockCode, HolderKey, HolderName, InstitutionSlug, Kind, Form string
	EventDate, AnnouncedOn, AnnouncementURL                       string
	PresentPct                                                    float64
	PreviousPct                                                   *float64
	PresentVotes                                                  *int64
}

type SubstantialNoticeRow struct {
	StockCode, HolderKey, HolderName, InstitutionSlug, Kind, Form string
	EventDate, AnnouncedOn, AnnouncementURL                       string
	PresentPct, PreviousPct                                       *float64
	Ceased                                                        bool
}

// NoticeStats counts notices per holder and in all.
type NoticeStats struct {
	Parsed, Withheld int
	LatestAnnounced  string
	PerHolder        map[string]HolderNoticeStats
}

type HolderNoticeStats struct {
	Notices      int
	LatestNotice string
}

type FundHoldingRow struct {
	InstitutionSlug, FundName, FundCode, SourceKind, AsAt, StockCode, SecurityName string
	Units, Value, Weight                                                           *float64
}

type OwnershipFundRow struct {
	FundKey, Name, FundType, ASXCode, Manager, InstitutionSlug, Category, AsAt, Source string
	Size                                                                               *float64
}

// ShortPosition is a code's latest ASIC short position report line.
type ShortPosition struct {
	Pct    float64
	Issued float64
	Date   string
}

type OwnershipCompany struct {
	Name, Industry string
	MarketCap      *float64
}

const ownershipTimeout = 15 * time.Second

func ownershipCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, ownershipTimeout)
}

// ownershipRead runs a query and scans each row with scan. A missing table
// is no rows.
func ownershipRead(ctx context.Context, s *postgresStore, method, query string, args []any, scan func(pgx.Rows) error) error {
	ctx, cancel := ownershipCtx(ctx)
	defer cancel()
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce(method, err)
			return nil
		}
		return fmt.Errorf("%s: %w", method, err)
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return fmt.Errorf("%s: scan: %w", method, err)
		}
	}
	if err := rows.Err(); err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce(method, err)
			return nil
		}
		return fmt.Errorf("%s: %w", method, err)
	}
	return nil
}

func (s *postgresStore) OwnershipInstitutions(ctx context.Context) ([]OwnershipInstitutionRow, error) {
	var out []OwnershipInstitutionRow
	err := ownershipRead(ctx, s, "OwnershipInstitutions", `
		SELECT slug, name, kind, COALESCE(country, ''), COALESCE(website, ''), COALESCE(description, ''),
		       COALESCE(group_slug, ''), aum_aud::float8, COALESCE(aum_as_at::text, '')
		FROM ownership_institutions ORDER BY name`, nil,
		func(r pgx.Rows) error {
			var row OwnershipInstitutionRow
			if err := r.Scan(&row.Slug, &row.Name, &row.Kind, &row.Country, &row.Website, &row.Description,
				&row.Group, &row.AUM, &row.AUMAsAt); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// holderKindSQL is a holding's kind: its institution's, "corporate" for a
// holder that is a listed company, else "unclassified".
const holderKindSQL = `COALESCE(i.kind, CASE WHEN h.holder_key LIKE 'asx:%' THEN 'corporate' END, 'unclassified')`

// ownershipWhere builds "AND ..." clauses for a filter over alias h.
func ownershipWhere(f OwnershipFilter, args []any) (string, []any) {
	var b strings.Builder
	if f.StockCode != "" {
		args = append(args, f.StockCode)
		fmt.Fprintf(&b, " AND h.stock_code = $%d", len(args))
	}
	if f.HolderKey != "" {
		args = append(args, f.HolderKey)
		fmt.Fprintf(&b, " AND h.holder_key = $%d", len(args))
	}
	return b.String(), args
}

func (s *postgresStore) CurrentSubstantialHoldings(ctx context.Context, f OwnershipFilter) ([]SubstantialHoldingRow, error) {
	where, args := ownershipWhere(f, nil)
	var out []SubstantialHoldingRow
	err := ownershipRead(ctx, s, "CurrentSubstantialHoldings", `
		SELECT h.stock_code, h.holder_key, COALESCE(h.holder_name, ''), COALESCE(h.institution_slug, ''), `+holderKindSQL+`,
		       h.form, COALESCE(h.event_date::text, ''), h.announced_on::text, h.announcement_url,
		       h.present_pct::float8, h.previous_pct::float8, h.present_votes
		FROM v_substantial_holdings_current h
		LEFT JOIN ownership_institutions i ON i.slug = h.institution_slug
		WHERE true`+where+`
		ORDER BY h.stock_code, h.present_pct DESC`, args,
		func(r pgx.Rows) error {
			var row SubstantialHoldingRow
			if err := r.Scan(&row.StockCode, &row.HolderKey, &row.HolderName, &row.InstitutionSlug, &row.Kind, &row.Form,
				&row.EventDate, &row.AnnouncedOn, &row.AnnouncementURL, &row.PresentPct, &row.PreviousPct, &row.PresentVotes); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

func (s *postgresStore) SubstantialNotices(ctx context.Context, f OwnershipFilter, limit int) ([]SubstantialNoticeRow, error) {
	where, args := ownershipWhere(f, nil)
	args = append(args, limit)
	var out []SubstantialNoticeRow
	err := ownershipRead(ctx, s, "SubstantialNotices", `
		SELECT h.stock_code, h.holder_key, COALESCE(h.holder_name, ''), COALESCE(h.institution_slug, ''), `+holderKindSQL+`,
		       h.form, COALESCE(h.event_date::text, ''), h.announced_on::text, h.announcement_url,
		       h.present_pct::float8, h.previous_pct::float8, h.ceased
		FROM substantial_holder_notices h
		LEFT JOIN ownership_institutions i ON i.slug = h.institution_slug
		WHERE true`+where+`
		ORDER BY h.announced_on DESC, COALESCE(h.event_date, h.announced_on) DESC, h.announcement_url
		LIMIT $`+strconv.Itoa(len(args)), args,
		func(r pgx.Rows) error {
			var row SubstantialNoticeRow
			if err := r.Scan(&row.StockCode, &row.HolderKey, &row.HolderName, &row.InstitutionSlug, &row.Kind, &row.Form,
				&row.EventDate, &row.AnnouncedOn, &row.AnnouncementURL, &row.PresentPct, &row.PreviousPct, &row.Ceased); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

func (s *postgresStore) NoticeStats(ctx context.Context) (*NoticeStats, error) {
	st := &NoticeStats{PerHolder: map[string]HolderNoticeStats{}}
	err := ownershipRead(ctx, s, "NoticeStats", `
		SELECT holder_key, count(*), max(announced_on)::text FROM substantial_holder_notices GROUP BY holder_key`, nil,
		func(r pgx.Rows) error {
			var key, latest string
			var n int
			if err := r.Scan(&key, &n, &latest); err != nil {
				return err
			}
			st.PerHolder[key] = HolderNoticeStats{Notices: n, LatestNotice: latest}
			st.Parsed += n
			if latest > st.LatestAnnounced {
				st.LatestAnnounced = latest
			}
			return nil
		})
	if err != nil {
		return nil, err
	}
	err = ownershipRead(ctx, s, "NoticeStats.withheld", `
		SELECT count(*) FROM substantial_holder_notice_attempts WHERE outcome <> 'parsed'`, nil,
		func(r pgx.Rows) error { return r.Scan(&st.Withheld) })
	return st, err
}

func (s *postgresStore) LatestFundHoldings(ctx context.Context, f OwnershipFilter) ([]FundHoldingRow, error) {
	var args []any
	var where strings.Builder
	if f.StockCode != "" {
		args = append(args, f.StockCode)
		fmt.Fprintf(&where, " AND h.stock_code = $%d", len(args))
	}
	if f.InstitutionSlug != "" {
		args = append(args, f.InstitutionSlug)
		fmt.Fprintf(&where, " AND h.institution_slug = $%d", len(args))
	}
	var out []FundHoldingRow
	err := ownershipRead(ctx, s, "LatestFundHoldings", `
		SELECT h.institution_slug, h.fund_name, COALESCE(h.fund_code, ''), h.source_kind, h.as_at::text, h.stock_code,
		       COALESCE(h.security_name, ''), h.units::float8, h.value_aud::float8, h.weight_pct::float8
		FROM v_fund_holdings_latest h
		WHERE true`+where.String()+`
		ORDER BY h.value_aud DESC NULLS LAST`, args,
		func(r pgx.Rows) error {
			var row FundHoldingRow
			if err := r.Scan(&row.InstitutionSlug, &row.FundName, &row.FundCode, &row.SourceKind, &row.AsAt, &row.StockCode,
				&row.SecurityName, &row.Units, &row.Value, &row.Weight); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

func (s *postgresStore) OwnershipFunds(ctx context.Context, institutionSlug string) ([]OwnershipFundRow, error) {
	query := `
		SELECT fund_key, name, fund_type, COALESCE(asx_code, ''), COALESCE(manager_name, ''), COALESCE(institution_slug, ''),
		       COALESCE(category, ''), COALESCE(aum_as_at::text, ''), source, aum_aud::float8
		FROM ownership_funds`
	var args []any
	if institutionSlug != "" {
		query += ` WHERE institution_slug = $1`
		args = append(args, institutionSlug)
	}
	query += ` ORDER BY aum_aud DESC NULLS LAST, name`
	var out []OwnershipFundRow
	err := ownershipRead(ctx, s, "OwnershipFunds", query, args,
		func(r pgx.Rows) error {
			var row OwnershipFundRow
			if err := r.Scan(&row.FundKey, &row.Name, &row.FundType, &row.ASXCode, &row.Manager, &row.InstitutionSlug,
				&row.Category, &row.AsAt, &row.Source, &row.Size); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// LatestShortPositions is each code's newest line of ASIC's short position
// report in the fortnight to the latest report.
func (s *postgresStore) LatestShortPositions(ctx context.Context) (map[string]ShortPosition, error) {
	out := map[string]ShortPosition{}
	err := ownershipRead(ctx, s, "LatestShortPositions", `
		SELECT DISTINCT ON ("PRODUCT_CODE") "PRODUCT_CODE",
		       COALESCE("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", 0)::float8,
		       COALESCE("TOTAL_PRODUCT_IN_ISSUE", 0)::float8, "DATE"::date::text
		FROM shorts
		WHERE "DATE" >= (SELECT max("DATE") FROM shorts) - interval '14 days'
		ORDER BY "PRODUCT_CODE", "DATE" DESC`, nil,
		func(r pgx.Rows) error {
			var code string
			var p ShortPosition
			if err := r.Scan(&code, &p.Pct, &p.Issued, &p.Date); err != nil {
				return err
			}
			out[strings.ToUpper(strings.TrimSpace(code))] = p
			return nil
		})
	return out, err
}

// marketCapSQL reads company-metadata.market_cap whatever its type: a bigint
// locally, text in production, where a missing value is an empty string and a
// bare ::float8 cast fails the whole read (22P02). Anything that is not a
// number reads as NULL, an unknown market cap.
const marketCapSQL = `CASE WHEN btrim(market_cap::text) ~ '^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$'
		THEN btrim(market_cap::text)::float8 END`

func (s *postgresStore) OwnershipCompanies(ctx context.Context) (map[string]OwnershipCompany, error) {
	out := map[string]OwnershipCompany{}
	err := ownershipRead(ctx, s, "OwnershipCompanies", `
		SELECT stock_code, COALESCE(company_name, ''), COALESCE(industry, ''), `+marketCapSQL+`
		FROM "company-metadata"`, nil,
		func(r pgx.Rows) error {
			var code string
			var c OwnershipCompany
			if err := r.Scan(&code, &c.Name, &c.Industry, &c.MarketCap); err != nil {
				return err
			}
			out[strings.ToUpper(strings.TrimSpace(code))] = c
			return nil
		})
	return out, err
}
