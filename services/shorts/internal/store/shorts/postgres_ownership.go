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
	NoticeCountsByStock(ctx context.Context) (map[string]int, error)
	AttemptOutcomes(ctx context.Context) ([]AttemptOutcomeRow, error)
	LatestFundHoldings(ctx context.Context, filter OwnershipFilter) ([]FundHoldingRow, error)
	OwnershipFunds(ctx context.Context, institutionSlug string) ([]OwnershipFundRow, error)
	LatestShortPositions(ctx context.Context) (map[string]ShortPosition, error)
	OwnershipCompanies(ctx context.Context) (map[string]OwnershipCompany, error)
	SubstantialNoticesPage(ctx context.Context, filter NoticeFilter, cursorDate, cursorURL string, limit int) ([]SubstantialNoticeRow, error)
	CountSubstantialNotices(ctx context.Context, filter NoticeFilter) (int, error)
	NoticeActivity(ctx context.Context, filter NoticeFilter) (NoticeActivityRows, error)
}

// The Postgres store is the one implementation; a signature drift here would
// otherwise nil the store at runtime, because the server finds it by type
// assertion.
var _ OwnershipStore = (*postgresStore)(nil)

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
	// ReadBy is "parser" or "model" (migration 000154); "parser" when the schema lacks it.
	ReadBy string
}

// NoticeStats counts notices per holder and in all.
type NoticeStats struct {
	Parsed, Withheld int
	// ReadByModel counts parsed notices a model read (read_by = model); 0 without 000154.
	ReadByModel     int
	LatestAnnounced string
	PerHolder       map[string]HolderNoticeStats
}

type HolderNoticeStats struct {
	Notices      int
	LatestNotice string
}

// AttemptOutcomeRow counts one stock's documents with one outcome. Parsed
// notices are included: the caller decides what withholds.
type AttemptOutcomeRow struct {
	StockCode, Outcome string
	Count              int
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

// SubstantialNotices is a stock's or a holder's notices, newest first. It reads the
// feed's columns and scans them with the feed's scan, so a column added to one read
// is in both.
func (s *postgresStore) SubstantialNotices(ctx context.Context, f OwnershipFilter, limit int) ([]SubstantialNoticeRow, error) {
	where, args := ownershipWhere(f, nil)
	args = append(args, limit)
	var out []SubstantialNoticeRow
	err := ownershipRead(ctx, s, "SubstantialNotices", `
		SELECT `+s.noticeColumns(ctx)+`
		`+noticeFrom+`
		WHERE true`+where+`
		ORDER BY h.announced_on DESC, COALESCE(h.event_date, h.announced_on) DESC, h.announcement_url
		LIMIT $`+strconv.Itoa(len(args)), args,
		func(r pgx.Rows) error {
			var row SubstantialNoticeRow
			if err := scanSubstantialNotice(r, &row); err != nil {
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
	if err != nil {
		return st, err
	}
	if s.noticeReadBy(ctx) == "h.read_by" {
		err = ownershipRead(ctx, s, "NoticeStats.readByModel", `
			SELECT count(*) FROM substantial_holder_notices WHERE read_by = 'model'`, nil,
			func(r pgx.Rows) error { return r.Scan(&st.ReadByModel) })
	}
	return st, err
}

// NoticeCountsByStock is every code's parsed notices. It is one whole-table
// GROUP BY, read once per universe build, so no per-code statement exists.
func (s *postgresStore) NoticeCountsByStock(ctx context.Context) (map[string]int, error) {
	out := map[string]int{}
	err := ownershipRead(ctx, s, "NoticeCountsByStock", `
		SELECT stock_code, count(*) FROM substantial_holder_notices GROUP BY stock_code`, nil,
		func(r pgx.Rows) error {
			var code string
			var n int
			if err := r.Scan(&code, &n); err != nil {
				return err
			}
			out[code] = n
			return nil
		})
	return out, err
}

// AttemptOutcomes is every code's documents by outcome, one whole-table GROUP
// BY read once per universe build.
func (s *postgresStore) AttemptOutcomes(ctx context.Context) ([]AttemptOutcomeRow, error) {
	var out []AttemptOutcomeRow
	err := ownershipRead(ctx, s, "AttemptOutcomes", `
		SELECT stock_code, outcome, count(*) FROM substantial_holder_notice_attempts GROUP BY stock_code, outcome`, nil,
		func(r pgx.Rows) error {
			var row AttemptOutcomeRow
			if err := r.Scan(&row.StockCode, &row.Outcome, &row.Count); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
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
			row.SecurityName = servedOwnershipName(row.StockCode, row.SecurityName)
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

// marketCapSQL reads a company-metadata market cap column whatever its type: a
// bigint locally, text in production, where a missing value is an empty string
// and a bare ::float8 cast fails the whole read (22P02). Anything that is not a
// number reads as NULL, an unknown market cap.
func marketCapSQL(col string) string {
	return `CASE WHEN btrim(` + col + `::text) ~ '^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$'
		THEN btrim(` + col + `::text)::float8 END`
}

func (s *postgresStore) OwnershipCompanies(ctx context.Context) (map[string]OwnershipCompany, error) {
	out := map[string]OwnershipCompany{}
	err := ownershipRead(ctx, s, "OwnershipCompanies", `
		SELECT stock_code, COALESCE(company_name, ''), COALESCE(industry, ''), `+marketCapSQL("market_cap")+`
		FROM "company-metadata"`, nil,
		func(r pgx.Rows) error {
			var code string
			var c OwnershipCompany
			if err := r.Scan(&code, &c.Name, &c.Industry, &c.MarketCap); err != nil {
				return err
			}
			c.Name = servedOwnershipName(code, c.Name)
			out[strings.ToUpper(strings.TrimSpace(code))] = c
			return nil
		})
	return out, err
}

// The notices feed (ListSubstantialNotices, the explorer). A page is one indexed
// keyset read and one count; a window of a quarter or less adds one aggregate
// and two bounded move reads. A notice's event is decided once, in Event.
// noticeEventSQL is the same rule for the feed's filter and activity: a pg test
// selects both for every notice and compares them.

// NoticeFilter narrows the notices feed. Empty fields do not filter. Since and
// Until are release dates, YYYY-MM-DD, inclusive at both ends; empty for no date
// clause. Industry is the stock's industry as company-metadata states it.
// HolderKey is one holder's key: a registry slug is its institution's notices,
// keyed as the institution page keys them.
type NoticeFilter struct {
	Since     string
	Until     string
	Event     string
	Kind      string
	Industry  string
	StockCode string
	HolderKey string
}

// The notice events: the vocabulary of SubstantialNotice.event.
const (
	EventCeased    = "ceased"
	EventBecame    = "became"
	EventIncreased = "increased"
	EventDecreased = "decreased"
	EventChanged   = "changed"
	EventNZ        = "nz"
)

// Event is the notice's event, ceased first: a cessation is ceased whatever its
// form says, a 603 became substantial, and a 604 is a move only when both
// figures are stated and differ.
func (r SubstantialNoticeRow) Event() string {
	switch {
	case r.Ceased || r.Form == "605":
		return EventCeased
	case r.Form == "603":
		return EventBecame
	case r.Form == "604" && r.PresentPct != nil && r.PreviousPct != nil && *r.PresentPct != *r.PreviousPct:
		if *r.PresentPct > *r.PreviousPct {
			return EventIncreased
		}
		return EventDecreased
	case r.Form == "604":
		return EventChanged
	default:
		return EventNZ
	}
}

// noticeEventSQL is Event over alias h.
const noticeEventSQL = `CASE
		WHEN h.ceased OR h.form = '605' THEN '` + EventCeased + `'
		WHEN h.form = '603' THEN '` + EventBecame + `'
		WHEN h.form = '604' AND h.present_pct IS NOT NULL AND h.previous_pct IS NOT NULL AND h.present_pct <> h.previous_pct
			THEN CASE WHEN h.present_pct > h.previous_pct THEN '` + EventIncreased + `' ELSE '` + EventDecreased + `' END
		WHEN h.form = '604' THEN '` + EventChanged + `'
		ELSE '` + EventNZ + `' END`

// noticeColumnsBase is a notice as the feed and SubstantialNotices read it, over alias h
// and noticeFrom. The read_by column follows it: see noticeColumns.
const noticeColumnsBase = `h.stock_code, h.holder_key, COALESCE(h.holder_name, ''), COALESCE(h.institution_slug, ''), ` + holderKindSQL + `,
		       h.form, COALESCE(h.event_date::text, ''), h.announced_on::text, h.announcement_url,
		       h.present_pct::float8, h.previous_pct::float8, h.ceased`

// The read_by probe's answers, cached on the store: a schema is migrated, not rolled
// back under a running process, so one answer per process is enough.
const (
	readByUnknown int32 = iota
	readByAbsent
	readByPresent
)

// readByAbsentTTL is how long an absent answer is trusted before the probe runs again.
const readByAbsentTTL = 5 * time.Minute

// noticeColumns is noticeColumnsBase and the notice's read_by.
func (s *postgresStore) noticeColumns(ctx context.Context) string {
	return noticeColumnsBase + ", " + s.noticeReadBy(ctx)
}

// noticeReadBy is the SQL for a notice's read_by over alias h. A schema without
// migration 000154 has no column, so it reads 'parser' (42703 is never sent, and the
// feed is not emptied by ownershipRead's missing-schema path). A probe that fails is
// answered 'parser' and not cached, so a transient error is never kept.
func (s *postgresStore) noticeReadBy(ctx context.Context) string {
	switch s.readBy.Load() {
	case readByPresent:
		return "h.read_by"
	case readByAbsent:
		if time.Since(time.Unix(0, s.readByAbsentAt.Load())) < readByAbsentTTL {
			return "'parser'"
		}
	}
	ctx, cancel := ownershipCtx(ctx)
	defer cancel()
	var present bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pg_attribute
		               WHERE attrelid = to_regclass('substantial_holder_notices')
		                 AND attname = 'read_by' AND NOT attisdropped)`).Scan(&present)
	if err != nil {
		return "'parser'"
	}
	if present {
		s.readBy.Store(readByPresent)
		return "h.read_by"
	}
	s.readByAbsentAt.Store(time.Now().UnixNano())
	s.readBy.Store(readByAbsent)
	return "'parser'"
}

// noticeFrom is the notices table with each notice's institution, for its kind.
const noticeFrom = `FROM substantial_holder_notices h
		LEFT JOIN ownership_institutions i ON i.slug = h.institution_slug`

// noticeWhere builds "AND ..." clauses for a feed filter over aliases h and i.
func noticeWhere(f NoticeFilter, args []any) (string, []any) {
	var b strings.Builder
	if f.Since != "" {
		args = append(args, f.Since)
		fmt.Fprintf(&b, " AND h.announced_on >= $%d::date", len(args))
	}
	if f.Event != "" {
		args = append(args, f.Event)
		fmt.Fprintf(&b, " AND %s = $%d", noticeEventSQL, len(args))
	}
	if f.Until != "" {
		args = append(args, f.Until)
		fmt.Fprintf(&b, " AND h.announced_on <= $%d::date", len(args))
	}
	if f.Kind != "" {
		args = append(args, f.Kind)
		fmt.Fprintf(&b, " AND %s = $%d", holderKindSQL, len(args))
	}
	if f.Industry != "" {
		args = append(args, f.Industry)
		fmt.Fprintf(&b, " AND h.stock_code IN (SELECT stock_code FROM \"company-metadata\" WHERE industry = $%d)", len(args))
	}
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

// noticeDeltaSQL is the change in voting power a notice states, in percentage points,
// over alias h. The tests read the same rule in Go (noticeDelta), so the two agree.
const noticeDeltaSQL = `CASE
		WHEN h.ceased OR h.form = '605' THEN -(h.previous_pct::float8)
		WHEN h.previous_pct IS NULL THEN h.present_pct::float8
		WHEN h.present_pct IS NULL THEN NULL
		ELSE h.present_pct::float8 - h.previous_pct::float8 END`

func scanSubstantialNotice(r pgx.Rows, row *SubstantialNoticeRow) error {
	return r.Scan(&row.StockCode, &row.HolderKey, &row.HolderName, &row.InstitutionSlug, &row.Kind, &row.Form,
		&row.EventDate, &row.AnnouncedOn, &row.AnnouncementURL, &row.PresentPct, &row.PreviousPct, &row.Ceased, &row.ReadBy)
}

// SubstantialNoticesPage is one page of the feed, newest release first. The
// cursor is the previous page's last notice: its release date and announcement
// URL, the primary key. Both are needed, because several notices share a
// release date. The caller asks for one row more than a page, to learn whether
// another page follows.
func (s *postgresStore) SubstantialNoticesPage(ctx context.Context, f NoticeFilter, cursorDate, cursorURL string, limit int) ([]SubstantialNoticeRow, error) {
	where, args := noticeWhere(f, nil)
	if cursorDate != "" {
		args = append(args, cursorDate, cursorURL)
		where += fmt.Sprintf(" AND (h.announced_on, h.announcement_url) < ($%d::date, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit)
	var out []SubstantialNoticeRow
	err := ownershipRead(ctx, s, "SubstantialNoticesPage", `
		SELECT `+s.noticeColumns(ctx)+`
		`+noticeFrom+`
		WHERE true`+where+`
		ORDER BY h.announced_on DESC, h.announcement_url DESC
		LIMIT $`+strconv.Itoa(len(args)), args,
		func(r pgx.Rows) error {
			var row SubstantialNoticeRow
			if err := scanSubstantialNotice(r, &row); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// CountSubstantialNotices is the feed's total: every notice the filter matches
// in its window, whatever the cursor.
func (s *postgresStore) CountSubstantialNotices(ctx context.Context, f NoticeFilter) (int, error) {
	where, args := noticeWhere(f, nil)
	n := 0
	err := ownershipRead(ctx, s, "CountSubstantialNotices", `
		SELECT count(*) `+noticeFrom+`
		WHERE true`+where, args,
		func(r pgx.Rows) error { return r.Scan(&n) })
	return n, err
}

// NoticeWeekRow is one ISO week's notices by event. WeekStart is its Monday.
type NoticeWeekRow struct {
	WeekStart                                         string
	Became, Increased, Decreased, Changed, Ceased, NZ int
}

// NoticeActivityRows is a window's activity as the store reads it: the weeks
// that hold notices, and the largest rises and falls (at most five each).
type NoticeActivityRows struct {
	Weeks []NoticeWeekRow
	Rises []SubstantialNoticeRow
	Falls []SubstantialNoticeRow
}

// NoticeActivity is the window's activity: one aggregate by week and event, and
// the largest moves. The service fills in the weeks that hold no notice.
func (s *postgresStore) NoticeActivity(ctx context.Context, f NoticeFilter) (NoticeActivityRows, error) {
	where, args := noticeWhere(f, nil)
	var out NoticeActivityRows
	err := ownershipRead(ctx, s, "NoticeActivity", `
		SELECT ev.week_start::text,
		       count(*) FILTER (WHERE ev.notice_event = '`+EventBecame+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventIncreased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventDecreased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventChanged+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventCeased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventNZ+`')
		FROM (
			SELECT date_trunc('week', h.announced_on::timestamp)::date AS week_start, `+noticeEventSQL+` AS notice_event
			`+noticeFrom+`
			WHERE true`+where+`
		) ev
		GROUP BY ev.week_start
		ORDER BY ev.week_start`, args,
		func(r pgx.Rows) error {
			var w NoticeWeekRow
			if err := r.Scan(&w.WeekStart, &w.Became, &w.Increased, &w.Decreased, &w.Changed, &w.Ceased, &w.NZ); err != nil {
				return err
			}
			out.Weeks = append(out.Weeks, w)
			return nil
		})
	if err != nil {
		return out, err
	}
	if out.Rises, err = s.noticeMoves(ctx, f, EventIncreased, "DESC"); err != nil {
		return out, err
	}
	out.Falls, err = s.noticeMoves(ctx, f, EventDecreased, "ASC")
	return out, err
}

// noticeMoves is the window's largest rises (increased, DESC) or falls
// (decreased, ASC) by their size in percentage points: at most five.
func (s *postgresStore) noticeMoves(ctx context.Context, f NoticeFilter, event, order string) ([]SubstantialNoticeRow, error) {
	where, args := noticeWhere(f, nil)
	args = append(args, event)
	where += fmt.Sprintf(" AND %s = $%d", noticeEventSQL, len(args))
	var out []SubstantialNoticeRow
	err := ownershipRead(ctx, s, "NoticeActivity.moves", `
		SELECT `+s.noticeColumns(ctx)+`
		`+noticeFrom+`
		WHERE true`+where+`
		ORDER BY (h.present_pct - h.previous_pct) `+order+`, h.announced_on DESC, h.announcement_url DESC
		LIMIT 5`, args,
		func(r pgx.Rows) error {
			var row SubstantialNoticeRow
			if err := scanSubstantialNotice(r, &row); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// The desk (migration 000137, spec section 13). These reads are the desk's
// instruments: the window's change per stock, its change by kind and industry,
// each industry's notices by week, the index fund snapshots and a stock's fund
// series. The notices reads run over the table, bounded by their dates; the
// fund reads run over the snapshot tables. All of them go through ownershipRead,
// so a schema without 000137 reads empty.

// OwnershipDeskStore is the desk's read surface. The server finds it by type
// assertion on the same store, so a store without it answers the desk rpcs empty.
type OwnershipDeskStore interface {
	NoticeFlowByStock(ctx context.Context, from, until string) (map[string]NoticeFlow, error)
	NoticeChangesByKindIndustry(ctx context.Context, from, until string) ([]NoticeChangeRow, error)
	NoticeWeeklyByIndustry(ctx context.Context, from, until, kind string) ([]IndustryWeekRow, error)
	NoticeLargestMoves(ctx context.Context, from, until, kind string, limit int) ([]SubstantialNoticeRow, error)
	FundSnapshotDates(ctx context.Context) ([]string, error)
	FundPositionPairs(ctx context.Context, from, until string) ([]FundPositionPair, error)
	StockFundSeries(ctx context.Context, stockCode string) ([]FundSeriesRow, error)
}

var _ OwnershipDeskStore = (*postgresStore)(nil)

// NoticeFlow is one stock's notices released in a window: how many, and the net
// change in disclosed voting power they state (Has is false when none states a
// figure).
type NoticeFlow struct {
	Notices int
	Net     float64
	Has     bool
}

// NoticeChangeRow is one holder kind's change in one industry over a window, in
// one direction: the notices that moved and the estimated exposure they moved
// (the change over 100, times the market cap; HasExposure is false when no
// notice's stock has a market cap).
type NoticeChangeRow struct {
	Kind, Industry string
	Up             bool
	ExposureAUD    float64
	HasExposure    bool
	Notices        int
}

// IndustryWeekRow is one industry's notices in one ISO week, by event, and the
// net change in disclosed voting power they state (NetPP is nil when none does).
type IndustryWeekRow struct {
	Industry, WeekStart                               string
	Became, Increased, Decreased, Changed, Ceased, NZ int
	NetPP                                             *float64
}

// FundPositionPair is one stock's holding in one fund, on the two snapshot dates
// being compared. The fund is compared only when it has a snapshot at or before
// each date, and each side is that fund's newest snapshot at or before the date.
type FundPositionPair struct {
	InstitutionSlug, FundName, StockCode, SecurityName string
	InFrom, InTo                                       bool
	FromWeight, FromValue, ToWeight, ToValue           *float64
}

// FundSeriesRow is one fund's holding of a stock at one snapshot. Units is nil
// when the file states none.
type FundSeriesRow struct {
	InstitutionSlug, FundName, FundCode, SourceKind, AsAt string
	Weight, Value, Units                                  *float64
}

// fundSourceKinds are the tracked funds: index funds' files and super fund
// options' disclosures.
const fundSourceKinds = `('etf', 'super_phd')`

// NoticeFlowByStock is every stock's notices released in [from, until] and the
// net change they state, one whole-window aggregate.
func (s *postgresStore) NoticeFlowByStock(ctx context.Context, from, until string) (map[string]NoticeFlow, error) {
	out := map[string]NoticeFlow{}
	err := ownershipRead(ctx, s, "NoticeFlowByStock", `
		SELECT x.stock_code, count(*), COALESCE(sum(x.delta), 0)::float8, count(x.delta)
		FROM (
			SELECT h.stock_code, `+noticeDeltaSQL+` AS delta
			FROM substantial_holder_notices h
			WHERE h.announced_on BETWEEN $1::date AND $2::date
		) x
		GROUP BY x.stock_code`, []any{from, until},
		func(r pgx.Rows) error {
			var code string
			var f NoticeFlow
			var known int
			if err := r.Scan(&code, &f.Notices, &f.Net, &known); err != nil {
				return err
			}
			f.Has = known > 0
			out[code] = f
			return nil
		})
	return out, err
}

// NoticeChangesByKindIndustry is the window's moves by holder kind and industry,
// split by direction. A notice that states no change is in none of them. The
// exposure is the change over 100 times the stock's market cap, guarded like the
// register's own market cap. A stock with no positive market cap adds no exposure,
// and its notice is not counted in the capped count.
func (s *postgresStore) NoticeChangesByKindIndustry(ctx context.Context, from, until string) ([]NoticeChangeRow, error) {
	var out []NoticeChangeRow
	err := ownershipRead(ctx, s, "NoticeChangesByKindIndustry", `
		SELECT x.kind, x.industry, (x.delta > 0), sum(x.delta / 100 * x.market_cap) FILTER (WHERE x.market_cap > 0),
		       count(x.market_cap) FILTER (WHERE x.market_cap > 0), count(*)
		FROM (
			SELECT `+holderKindSQL+` AS kind, COALESCE(cm.industry, '') AS industry,
			       `+noticeDeltaSQL+` AS delta, `+marketCapSQL("cm.market_cap")+` AS market_cap
			FROM substantial_holder_notices h
			LEFT JOIN ownership_institutions i ON i.slug = h.institution_slug
			LEFT JOIN "company-metadata" cm ON cm.stock_code = h.stock_code
			WHERE h.announced_on BETWEEN $1::date AND $2::date
		) x
		WHERE x.delta IS NOT NULL AND x.delta <> 0
		GROUP BY x.kind, x.industry, (x.delta > 0)
		ORDER BY x.kind, x.industry`, []any{from, until},
		func(r pgx.Rows) error {
			var row NoticeChangeRow
			var exposure *float64
			var withCap int
			if err := r.Scan(&row.Kind, &row.Industry, &row.Up, &exposure, &withCap, &row.Notices); err != nil {
				return err
			}
			if exposure != nil {
				row.ExposureAUD = *exposure
			}
			row.HasExposure = withCap > 0
			out = append(out, row)
			return nil
		})
	return out, err
}

// NoticeWeeklyByIndustry is each industry's notices released in [from, until] by
// ISO week, one aggregate. A kind other than "" counts only the notices of holders
// of that kind. A week with no notice in an industry has no row; the service fills
// the gaps.
func (s *postgresStore) NoticeWeeklyByIndustry(ctx context.Context, from, until, kind string) ([]IndustryWeekRow, error) {
	var out []IndustryWeekRow
	err := ownershipRead(ctx, s, "NoticeWeeklyByIndustry", `
		SELECT ev.industry, ev.week_start::text,
		       count(*) FILTER (WHERE ev.notice_event = '`+EventBecame+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventIncreased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventDecreased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventChanged+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventCeased+`'),
		       count(*) FILTER (WHERE ev.notice_event = '`+EventNZ+`'),
		       sum(ev.delta)::float8
		FROM (
			SELECT COALESCE(cm.industry, '') AS industry, date_trunc('week', h.announced_on::timestamp)::date AS week_start,
			       `+noticeEventSQL+` AS notice_event, `+noticeDeltaSQL+` AS delta
			FROM substantial_holder_notices h
			LEFT JOIN "company-metadata" cm ON cm.stock_code = h.stock_code
			LEFT JOIN ownership_institutions i ON i.slug = h.institution_slug
			WHERE h.announced_on BETWEEN $1::date AND $2::date
			  AND ($3 = '' OR `+holderKindSQL+` = $3)
		) ev
		GROUP BY ev.industry, ev.week_start
		ORDER BY ev.week_start, ev.industry`, []any{from, until, kind},
		func(r pgx.Rows) error {
			var w IndustryWeekRow
			if err := r.Scan(&w.Industry, &w.WeekStart, &w.Became, &w.Increased, &w.Decreased, &w.Changed,
				&w.Ceased, &w.NZ, &w.NetPP); err != nil {
				return err
			}
			out = append(out, w)
			return nil
		})
	return out, err
}

// NoticeLargestMoves is the window's notices that state a change in voting power
// (spec 14.10): both figures stated, neither a cessation nor a Form 605, and a
// difference. Ranked by the size of the change, then the newer release, then the
// stock code, then the announcement URL; at most limit. A kind other than ""
// counts only holders of that kind. The desk's Go rule (buildLargestMoves) keeps
// the same filter.
func (s *postgresStore) NoticeLargestMoves(ctx context.Context, from, until, kind string, limit int) ([]SubstantialNoticeRow, error) {
	where, args := noticeWhere(NoticeFilter{Since: from, Until: until, Kind: kind}, nil)
	args = append(args, limit)
	var out []SubstantialNoticeRow
	err := ownershipRead(ctx, s, "NoticeLargestMoves", `
		SELECT `+s.noticeColumns(ctx)+`
		`+noticeFrom+`
		WHERE h.present_pct IS NOT NULL AND h.previous_pct IS NOT NULL
		  AND NOT h.ceased AND h.form <> '605'
		  AND h.present_pct <> h.previous_pct`+where+`
		ORDER BY abs(h.present_pct - h.previous_pct) DESC, h.announced_on DESC,
		         h.stock_code, h.announcement_url DESC
		LIMIT $`+strconv.Itoa(len(args)), args,
		func(r pgx.Rows) error {
			var row SubstantialNoticeRow
			if err := scanSubstantialNotice(r, &row); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// FundSnapshotDates is every distinct file date across the tracked funds, oldest
// first.
func (s *postgresStore) FundSnapshotDates(ctx context.Context) ([]string, error) {
	var out []string
	err := ownershipRead(ctx, s, "FundSnapshotDates", `
		SELECT DISTINCT as_at::text FROM fund_holding_snapshots
		WHERE source_kind IN `+fundSourceKinds+`
		ORDER BY 1`, nil,
		func(r pgx.Rows) error {
			var d string
			if err := r.Scan(&d); err != nil {
				return err
			}
			out = append(out, d)
			return nil
		})
	return out, err
}

// FundPositionPairs is every holding of the funds that have a snapshot at or
// before both dates, on each side: the fund's newest snapshot at or before the
// date. A fund with no snapshot at or before one of the dates is not compared.
func (s *postgresStore) FundPositionPairs(ctx context.Context, from, until string) ([]FundPositionPair, error) {
	var out []FundPositionPair
	err := ownershipRead(ctx, s, "FundPositionPairs", `
		WITH sf AS (
			SELECT DISTINCT ON (institution_slug, fund_name) id, institution_slug, fund_name
			FROM fund_holding_snapshots
			WHERE as_at <= $1::date AND source_kind IN `+fundSourceKinds+`
			ORDER BY institution_slug, fund_name, as_at DESC, id DESC
		), st AS (
			SELECT DISTINCT ON (institution_slug, fund_name) id, institution_slug, fund_name
			FROM fund_holding_snapshots
			WHERE as_at <= $2::date AND source_kind IN `+fundSourceKinds+`
			ORDER BY institution_slug, fund_name, as_at DESC, id DESC
		), common AS (
			SELECT sf.id AS from_id, st.id AS to_id, sf.institution_slug, sf.fund_name
			FROM sf JOIN st ON st.institution_slug = sf.institution_slug AND st.fund_name = sf.fund_name
		), fa AS (
			SELECT c.institution_slug, c.fund_name, h.stock_code, h.security_name, h.weight_pct, h.value_aud
			FROM common c JOIN fund_holdings h ON h.snapshot_id = c.from_id
		), fb AS (
			SELECT c.institution_slug, c.fund_name, h.stock_code, h.security_name, h.weight_pct, h.value_aud
			FROM common c JOIN fund_holdings h ON h.snapshot_id = c.to_id
		)
		SELECT COALESCE(fa.institution_slug, fb.institution_slug), COALESCE(fa.fund_name, fb.fund_name),
		       COALESCE(fa.stock_code, fb.stock_code), COALESCE(fb.security_name, fa.security_name, ''),
		       fa.stock_code IS NOT NULL, fa.weight_pct::float8, fa.value_aud::float8,
		       fb.stock_code IS NOT NULL, fb.weight_pct::float8, fb.value_aud::float8
		FROM fa FULL JOIN fb
		  ON fa.institution_slug = fb.institution_slug AND fa.fund_name = fb.fund_name AND fa.stock_code = fb.stock_code`,
		[]any{from, until},
		func(r pgx.Rows) error {
			var p FundPositionPair
			if err := r.Scan(&p.InstitutionSlug, &p.FundName, &p.StockCode, &p.SecurityName,
				&p.InFrom, &p.FromWeight, &p.FromValue, &p.InTo, &p.ToWeight, &p.ToValue); err != nil {
				return err
			}
			p.SecurityName = servedOwnershipName(p.StockCode, p.SecurityName)
			out = append(out, p)
			return nil
		})
	return out, err
}

// StockFundSeries is one stock's holding in every tracked fund at each snapshot,
// grouped by fund and oldest first.
func (s *postgresStore) StockFundSeries(ctx context.Context, stockCode string) ([]FundSeriesRow, error) {
	var out []FundSeriesRow
	err := ownershipRead(ctx, s, "StockFundSeries", `
		SELECT f.institution_slug, f.fund_name, COALESCE(f.fund_code, ''), f.source_kind, f.as_at::text, h.weight_pct::float8, h.value_aud::float8, h.units::float8
		FROM fund_holding_snapshots f
		JOIN fund_holdings h ON h.snapshot_id = f.id
		WHERE h.stock_code = $1 AND f.source_kind IN `+fundSourceKinds+`
		ORDER BY f.institution_slug, f.fund_name, f.as_at`, []any{stockCode},
		func(r pgx.Rows) error {
			var row FundSeriesRow
			if err := r.Scan(&row.InstitutionSlug, &row.FundName, &row.FundCode, &row.SourceKind, &row.AsAt, &row.Weight, &row.Value, &row.Units); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// The fund explorer's reads (ListFunds, GetFundPortfolio, CompareFundSnapshots).
// Every file is a fund_holding_snapshots row; a fund is one (institution, fund
// name) pair across its files. The registry row (ownership_funds) is matched in
// the service, by institution and ASX code, so these reads stay one statement
// each. The shares on issue are ASIC's as at the file date, the newest short
// report line on or before it.

// OwnershipFundStore is the fund explorer's read surface. The server finds it by
// type assertion on the same store, so a store without it answers the fund rpcs
// empty.
type OwnershipFundStore interface {
	FundFiles(ctx context.Context) ([]FundFileRow, error)
	FundHoldingsOf(ctx context.Context, snapshotIDs []int64, withShares bool) ([]FundHoldingDetail, error)
	FundCompareRows(ctx context.Context, fromID, toID int64) ([]FundCompareRow, error)
}

var _ OwnershipFundStore = (*postgresStore)(nil)

// FundFileRow is one holdings file of a tracked fund: its snapshot, the
// institution's name, the file's date and where it was read from.
type FundFileRow struct {
	ID                                         int64
	InstitutionSlug, InstitutionName, FundName string
	FundCode, SourceKind, SourceURL, AsAt      string
}

// fundSharesMaxDays is how old the ASIC report behind a shares-on-issue figure may
// be, in days before the file date. Older than this, the figure is withheld rather
// than estimated from a stale count.
const fundSharesMaxDays = 30

// FundHoldingDetail is one holding in one file: its weight, units and value as
// the file states them, its company's industry, and (when asked) the shares on
// issue ASIC reports, with the date of that report (SharesAsAt, "" when there is
// no figure). SecurityName is the company's name from company-metadata, else the
// file's own name for the holding.
type FundHoldingDetail struct {
	SnapshotID                         int64
	StockCode, SecurityName, Industry  string
	Units, Value, Weight, SharesIssued *float64
	SharesAsAt                         string
}

// FundCompareRow is one stock across two files of one fund: held in the earlier
// file (InFrom), the later (InTo), or both, with each side's weight and value.
// SecurityName is as in FundHoldingDetail.
type FundCompareRow struct {
	StockCode, SecurityName, Industry string
	InFrom, InTo                      bool
	FromWeight, FromValue             *float64
	ToWeight, ToValue                 *float64
}

// FundFiles is every holdings file of every tracked fund, oldest first.
func (s *postgresStore) FundFiles(ctx context.Context) ([]FundFileRow, error) {
	var out []FundFileRow
	err := ownershipRead(ctx, s, "FundFiles", `
		SELECT f.id, f.institution_slug, COALESCE(i.name, f.institution_slug), f.fund_name,
		       COALESCE(f.fund_code, ''), f.source_kind, f.source_url, f.as_at::text
		FROM fund_holding_snapshots f
		LEFT JOIN ownership_institutions i ON i.slug = f.institution_slug
		WHERE f.source_kind IN `+fundSourceKinds+`
		ORDER BY f.institution_slug, f.fund_name, f.as_at, f.id`, nil,
		func(r pgx.Rows) error {
			var row FundFileRow
			if err := r.Scan(&row.ID, &row.InstitutionSlug, &row.InstitutionName, &row.FundName,
				&row.FundCode, &row.SourceKind, &row.SourceURL, &row.AsAt); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// FundHoldingsOf is every holding of the given files. With withShares, each
// holding carries ASIC's shares on issue from the newest report on or before its
// file's date and no older than fundSharesMaxDays before it (nil when there is
// none), with that report's date.
func (s *postgresStore) FundHoldingsOf(ctx context.Context, snapshotIDs []int64, withShares bool) ([]FundHoldingDetail, error) {
	if len(snapshotIDs) == 0 {
		return nil, nil
	}
	shares := `NULL::float8, ''::text`
	join := ``
	if withShares {
		shares = `sh.issued::float8, COALESCE(sh.as_at, '')`
		join = `LEFT JOIN LATERAL (
			SELECT x."TOTAL_PRODUCT_IN_ISSUE" AS issued, x."DATE"::date::text AS as_at
			FROM shorts x
			WHERE x."PRODUCT_CODE" = h.stock_code
			  AND x."DATE" < (f.as_at + 1)
			  AND x."DATE" >= (f.as_at - ` + strconv.Itoa(fundSharesMaxDays) + `)
			ORDER BY x."DATE" DESC
			LIMIT 1
		) sh ON true`
	}
	var out []FundHoldingDetail
	err := ownershipRead(ctx, s, "FundHoldingsOf", `
		SELECT h.snapshot_id, h.stock_code, COALESCE(NULLIF(cm.company_name, ''), NULLIF(h.security_name, ''), ''),
		       COALESCE(cm.industry, ''), h.units::float8, h.value_aud::float8, h.weight_pct::float8, `+shares+`
		FROM fund_holdings h
		JOIN fund_holding_snapshots f ON f.id = h.snapshot_id
		LEFT JOIN "company-metadata" cm ON cm.stock_code = h.stock_code
		`+join+`
		WHERE h.snapshot_id = ANY($1::bigint[])
		ORDER BY h.snapshot_id, h.weight_pct DESC NULLS LAST, h.stock_code`, []any{snapshotIDs},
		func(r pgx.Rows) error {
			var d FundHoldingDetail
			if err := r.Scan(&d.SnapshotID, &d.StockCode, &d.SecurityName, &d.Industry,
				&d.Units, &d.Value, &d.Weight, &d.SharesIssued, &d.SharesAsAt); err != nil {
				return err
			}
			d.SecurityName = servedOwnershipName(d.StockCode, d.SecurityName)
			out = append(out, d)
			return nil
		})
	return out, err
}

// FundCompareRows is every holding in either of two files of one fund, a full
// join on the stock code.
func (s *postgresStore) FundCompareRows(ctx context.Context, fromID, toID int64) ([]FundCompareRow, error) {
	var out []FundCompareRow
	err := ownershipRead(ctx, s, "FundCompareRows", `
		WITH a AS (SELECT stock_code, security_name, weight_pct, value_aud FROM fund_holdings WHERE snapshot_id = $1),
		     b AS (SELECT stock_code, security_name, weight_pct, value_aud FROM fund_holdings WHERE snapshot_id = $2)
		SELECT COALESCE(a.stock_code, b.stock_code),
		       COALESCE(NULLIF(cm.company_name, ''), NULLIF(b.security_name, ''), NULLIF(a.security_name, ''), ''),
		       COALESCE(cm.industry, ''),
		       a.stock_code IS NOT NULL, a.weight_pct::float8, a.value_aud::float8,
		       b.stock_code IS NOT NULL, b.weight_pct::float8, b.value_aud::float8
		FROM a FULL JOIN b ON b.stock_code = a.stock_code
		LEFT JOIN "company-metadata" cm ON cm.stock_code = COALESCE(a.stock_code, b.stock_code)`,
		[]any{fromID, toID},
		func(r pgx.Rows) error {
			var row FundCompareRow
			if err := r.Scan(&row.StockCode, &row.SecurityName, &row.Industry,
				&row.InFrom, &row.FromWeight, &row.FromValue, &row.InTo, &row.ToWeight, &row.ToValue); err != nil {
				return err
			}
			row.SecurityName = servedOwnershipName(row.StockCode, row.SecurityName)
			out = append(out, row)
			return nil
		})
	return out, err
}
