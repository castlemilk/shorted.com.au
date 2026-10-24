package announcements

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// dividendNoticeParserVersion is bumped whenever parseDividendNotice or
// dividendRowsFor changes what a notice yields: a notice that failed under an
// older version is read again. Version 2 reads the NZ supplementary dividend
// (Part 3F) and splits a foreign notice's AUD equivalent across its parts.
// Version 3 records, for a notice that waits on its update, the ex-date and the
// date the notice promises the update by (waitingDetail), which the data
// review reads. Version 4 reads a notice under any code that listed it
// (listedAs), so the code mismatches it recorded are read again. Version 5
// reads an NZ total that leaves the supplementary out (AFP), takes the 1.3
// issuer code when 1.6 is blank (LED, Storage King), an estimate the notice
// calls actual (LED's finalisation), fields the text layer runs together
// (unglue), and a Part 3C scrip distribution: counted toward the total, never
// stored (BCN's cash part is stored; VMC, paid only in shares, is scrip_only).
// Version 6 stores an estimate once the issuer's own results document
// confirms it (dividend_estimate.go: GMG lodges one estimate a half and never
// an update, so it had no dividend rows), and reads an estimated_only notice
// again after its due date, once for each extraction of its listing code
// with a dividend and a period end made since it was read (a June estimate is
// read in June; its 4E is extracted 47 days after filing at the median). The
// bump itself re-reads GMG's: its v5 attempt (2026-10-12 11:29 UTC) is later
// than its 4E's extraction (2026-10-11 14:12 UTC), so no extraction is newer.
const dividendNoticeParserVersion = 6

// pendingNotice represents an unparsed dividend notice from the crawl.
type pendingNotice struct {
	StockCode        string   // the code whose announcements page listed it
	ListedCodes      []string // every code whose page listed the same PDF, sorted
	AnnouncementDate string   // YYYY-MM-DD
	Headline         string
	URL              string // asx_announcements.pdf_url
}

// codesMatch is rule 1's test: a notice's security code belongs to a code
// whose page listed it when the two share their first 3 characters (CBAPI,
// a hybrid, is listed under CBA).
func codesMatch(security, listed string) bool {
	return len(security) >= 3 && len(listed) >= 3 && strings.EqualFold(security[:3], listed[:3])
}

// listedAs is the notice under the listing its security code belongs to: its
// own when that matches, else another code whose page listed the same PDF.
// ASX lists a renamed company's announcements under its old code and its new
// one (D2O and RIV, WPL and WDS: 435 of 5,724 dividend notices on
// 2026-10-11), and the pass reads each PDF once, so a notice for RIV read
// under D2O was withheld as a mismatch while RIV's own page listed it.
func (p pendingNotice) listedAs(security string) pendingNotice {
	if codesMatch(security, p.StockCode) {
		return p
	}
	for _, c := range p.ListedCodes {
		if codesMatch(security, c) {
			p.StockCode = c
			return p
		}
	}
	return p
}

// dividendRow holds the parsed output of one dividend part, ready for upsert.
type dividendRow struct {
	StockCode, ExDate, RecordDate, PaymentDate, PeriodEnd string // dates YYYY-MM-DD; "" = unknown
	AmountAUD                                             float64
	FrankedPct                                            *float64 // nil = not stated
	Type                                                  string   // "ordinary" or "special"
	DeclaredCurrency                                      string
	DeclaredAmount                                        float64
	AnnouncementURL                                       string
	AnnouncedOn                                           string
}

// noticeAttempt records the outcome of processing one notice.
type noticeAttempt struct {
	URL, StockCode, Outcome, Detail string
	ParserVersion                   int
}

// dividendPassResult is the tally returned by runDividendNoticePass.
type dividendPassResult struct {
	Selected, Parsed, Rows int
	Outcomes               map[string]int
}

// dividendNoticeStore is the interface between the pass and storage.
type dividendNoticeStore interface {
	PendingDividendNotices(ctx context.Context, limit int, parserVersion int) ([]pendingNotice, error)
	UpsertDividends(ctx context.Context, rows []dividendRow) (int, error)
	RecordNoticeAttempt(ctx context.Context, a noticeAttempt) error
	// EstimateEvidence reads what decides whether an estimated_only notice is
	// stored from its results document (confirmEstimatedNotice): the
	// extractions of its security code, the rows stored for its code under
	// its ex-date or for its period, and the issuer's notices announced since.
	EstimateEvidence(ctx context.Context, n DividendNotice, p pendingNotice) (estimateEvidence, error)
	// UpsertConfirmedEstimates writes rows a results document confirmed. A
	// row is replaced only when it is the notice's own, or a confirmed
	// estimate from an earlier notice: never one stored from a declared
	// amount.
	UpsertConfirmedEstimates(ctx context.Context, rows []dividendRow) (int, error)
}

// noticeTextFunc fetches the text of an announcement PDF.
type noticeTextFunc func(ctx context.Context, url string) string

// roundTo8Decimals rounds v to 8 decimal places.
func roundTo8Decimals(v float64) float64 {
	return math.Round(v*1e8) / 1e8
}

// waitingDetail is the attempt detail of a notice that waits on its update:
// "ex 2026-10-12; actual amount due 2026-10-19". The ex-date ties the notice to
// the dividend its update stores; the data review (services/jobs/internal/jobs/
// review) reads both dates from this spelling.
func waitingDetail(n DividendNotice, what, due string) string {
	if due == "" {
		return "ex " + n.ExDate
	}
	return "ex " + n.ExDate + "; " + what + " due " + due
}

// dividendRowsFor extracts dividend rows from a parsed notice, applying policy.
// Policy:
//  1. SecurityCode and pendingNotice.StockCode must share their first 3 chars
//     (case-insensitive), else outcome "code_mismatch". The pass first moves a
//     notice to the listing its code matches (listedAs).
//  2. Drop parts with Estimated==true; if none remain, outcome "estimated_only".
//  3. Currency: if AUD, each row's AmountAUD is the part's Amount. If foreign
//     and AUDEquivalent is set, each part's AmountAUD is computed as
//     part.Amount * (AUDEquivalent / Total), rounded to 8 decimal places.
//     If foreign and AUDEquivalent is nil, outcome "awaiting_aud_equivalent".
//  4. Rows: StockCode=n.SecurityCode, dates from notice, FrankedPct and Type
//     from part, DeclaredCurrency=n.Currency, DeclaredAmount=part.Amount,
//     AnnouncementURL=p.URL, AnnouncedOn=n.AnnouncedOn or p.AnnouncementDate.
//     Outcome "parsed" with detail like "2 rows".
//
// An estimated_only notice may still be stored, by the pass, once its results
// document confirms the estimate (confirmEstimatedNotice).
func dividendRowsFor(n DividendNotice, p pendingNotice) (rows []dividendRow, outcome, detail string) {
	// Rule 1: code match (first 3 chars, case-insensitive)
	if !codesMatch(n.SecurityCode, p.StockCode) {
		listed := p.StockCode
		if len(p.ListedCodes) > 1 {
			listed = strings.Join(p.ListedCodes, ", ")
		}
		return nil, "code_mismatch", fmt.Sprintf("notice is for %s, listed under %s", n.SecurityCode, listed)
	}

	// Rule 2: drop estimated parts
	var parts []DividendPart
	for _, part := range n.Parts {
		if !part.Estimated {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return nil, "estimated_only", waitingDetail(n, "actual amount", n.ActualDue)
	}

	// Rule 4: build rows
	announcedOn := n.AnnouncedOn
	if announcedOn == "" {
		announcedOn = p.AnnouncementDate
	}

	for _, part := range parts {
		// Rule 3: determine AmountAUD per row
		var amountAUD float64
		switch n.Currency {
		case "AUD":
			amountAUD = part.Amount
		default:
			if n.AUDEquivalent == nil {
				return nil, "awaiting_aud_equivalent", waitingDetail(n, "AUD equivalent", n.AUDEquivalentDue)
			}
			// 2A.9a is the AUD equivalent of the whole 2A.9 total (with an
			// NZ supplementary or without it, as the issuer stated the
			// total), so each part takes its share at the notice's one
			// exchange rate.
			if n.Total > 0 {
				amountAUD = roundTo8Decimals(part.Amount * (*n.AUDEquivalent / n.Total))
			} else {
				amountAUD = *n.AUDEquivalent
			}
		}

		rows = append(rows, noticeRow(n, p, part, amountAUD, announcedOn))
	}

	return rows, "parsed", fmt.Sprintf("%d rows", len(rows))
}

// noticeRow is rule 4's row for one part of a notice.
func noticeRow(n DividendNotice, p pendingNotice, part DividendPart, amountAUD float64, announcedOn string) dividendRow {
	return dividendRow{
		StockCode:        n.SecurityCode,
		ExDate:           n.ExDate,
		RecordDate:       n.RecordDate,
		PaymentDate:      n.PaymentDate,
		PeriodEnd:        n.PeriodEnd,
		AmountAUD:        amountAUD,
		FrankedPct:       part.FrankedPct,
		Type:             part.Type,
		DeclaredCurrency: n.Currency,
		DeclaredAmount:   part.Amount,
		AnnouncementURL:  p.URL,
		AnnouncedOn:      announcedOn,
	}
}

// runDividendNoticePass downloads and parses unparsed dividend notices.
// It processes up to limit notices using workers goroutines, with delay between
// requests. On parse success, it upserts rows first; if that fails, no attempt is
// recorded (so the notice retries next run). Otherwise it records an attempt with
// the outcome. Dry-run logs but writes nothing.
//
// Returns Selected (notices fetched), Parsed (with outcome "parsed"), Rows (upserted),
// and Outcomes (per-outcome tally).
func runDividendNoticePass(
	ctx context.Context,
	store dividendNoticeStore,
	text noticeTextFunc,
	limit, workers int,
	delay time.Duration,
	dryRun bool,
	logf func(string, ...any),
) (dividendPassResult, error) {
	if workers < 1 {
		workers = 1
	}

	// Fetch pending notices
	pending, err := store.PendingDividendNotices(ctx, limit, dividendNoticeParserVersion)
	if err != nil {
		return dividendPassResult{}, err
	}

	result := dividendPassResult{
		Selected: len(pending),
		Outcomes: make(map[string]int),
	}

	if len(pending) == 0 {
		return result, nil
	}

	// Process with bounded concurrency
	workCh := make(chan pendingNotice)
	var mu sync.Mutex
	var wg sync.WaitGroup

	tally := func(outcome string, rows int) {
		mu.Lock()
		defer mu.Unlock()
		result.Outcomes[outcome]++
		if outcome == "parsed" {
			result.Parsed++
			result.Rows += rows
		}
	}
	record := func(n pendingNotice, outcome, detail string) {
		if dryRun {
			return
		}
		a := noticeAttempt{URL: n.URL, StockCode: n.StockCode, Outcome: outcome, Detail: detail, ParserVersion: dividendNoticeParserVersion}
		if err := store.RecordNoticeAttempt(ctx, a); err != nil {
			logf("dividend notice %s: recording outcome %s failed: %v", n.URL, outcome, err) // re-selected next run
		}
	}
	// confirmEstimate is an estimated_only notice's rows and attempt detail
	// when its results document confirms the estimate (confirmEstimatedNotice),
	// nil rows when it does not; the log says which, and why.
	confirmEstimate := func(notice DividendNotice, n pendingNotice) ([]dividendRow, string, error) {
		why := estimateConfirmable(notice)
		if why == "" {
			ev, err := store.EstimateEvidence(ctx, notice, n)
			if err != nil {
				return nil, "", err
			}
			rows, detail, reason := confirmEstimatedNotice(notice, n, ev)
			if reason == "" {
				logf("dividend notice %s: %s's estimate ex %s confirmed by its results document (%s)", n.URL, notice.SecurityCode, notice.ExDate, detail)
				return rows, detail, nil
			}
			why = reason
		}
		logf("dividend notice %s: %s's estimate ex %s not stored: %s", n.URL, notice.SecurityCode, notice.ExDate, why)
		return nil, "", nil
	}
	// handle takes one notice to its outcome. The caller sleeps after every
	// notice, whatever the outcome: each one costs ASX two requests.
	handle := func(n pendingNotice) {
		body := text(ctx, n.URL)
		if body == "" {
			tally("no_text", 0)
			record(n, "no_text", "")
			return
		}
		notice, parseOutcome, parseDetail := parseDividendNotice(body)
		if parseOutcome != noticeParsed {
			tally(string(parseOutcome), 0)
			record(n, string(parseOutcome), parseDetail)
			return
		}
		n = n.listedAs(notice.SecurityCode)
		rows, outcome, detail := dividendRowsFor(notice, n)
		// An estimate is stored once its results document confirms it; until
		// then waiting is "", and the notice keeps its estimated_only detail.
		upsert, waiting, note := store.UpsertDividends, "", ""
		if outcome == "estimated_only" {
			confirmed, confirmedDetail, err := confirmEstimate(notice, n)
			if err != nil {
				logf("dividend notice %s: reading what confirms its estimate failed: %v", n.URL, err)
				tally("store_error", 0) // no attempt recorded, so it is retried next run
				return
			}
			if confirmed != nil {
				waiting, note = detail, " ("+confirmedDetail+")"
				rows, outcome, detail = confirmed, "parsed", confirmedDetail
				upsert = store.UpsertConfirmedEstimates
			}
		}
		if outcome != "parsed" {
			tally(outcome, 0)
			record(n, outcome, detail)
			return
		}
		if dryRun {
			for _, r := range rows {
				logf("DRY-RUN dividend: %s %s ex %s A$%.6f (declared %s %.6f) from %s%s", r.StockCode, r.Type, r.ExDate,
					r.AmountAUD, r.DeclaredCurrency, r.DeclaredAmount, n.URL, note)
			}
			tally("parsed", len(rows))
			return
		}
		written, err := upsert(ctx, rows)
		if err != nil {
			logf("dividend notice %s: upsert failed: %v", n.URL, err)
			tally("store_error", 0) // no attempt recorded, so it is retried next run
			return
		}
		if waiting != "" && written == 0 {
			// A row stored from a declared amount arrived after the evidence
			// was read: it stands, and the notice still waits.
			tally("estimated_only", 0)
			record(n, "estimated_only", waiting)
			return
		}
		tally("parsed", written)
		record(n, "parsed", detail)
	}

	for w := 0; w < workers; w++ {
		wg.Go(func() {
			for n := range workCh {
				handle(n)
				if delay <= 0 {
					continue
				}
				timer := time.NewTimer(delay)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
		})
	}

	// Feed work
	go func() {
		defer close(workCh)
		for _, p := range pending {
			select {
			case workCh <- p:
			case <-ctx.Done():
				return
			}
		}
	}()

	wg.Wait()
	return result, ctx.Err()
}

// SQL const for pending notices (deduped, excluding recent attempts). Each
// carries every code that listed its PDF (listed_codes, for listedAs).
//
// An estimated_only notice is read again once its actual amount was due
// before today and an extraction of its listing code (the attempt's
// stock_code) with a dividend and a period end has been made since it was
// last read: an estimate is read weeks before its results document exists
// (GMG's of 2026-06-16; its 4E was filed 2026-08-20 and extracted
// 2026-10-11), so it could otherwise never be confirmed. Each new extraction
// costs one read of every such notice of its code: a code with N waiting
// estimates costs N reads (each two ASX requests and one of the run's
// -dividend-notices 200), and a monthly payer (MOT, MXT, PCI) holds about 30
// once the backlog is read. Most are superseded by a later notice, which
// confirmEstimatedNotice always withholds: every read fails safe, and the
// cost falls mostly in results season. The match is on the listing code, not
// the security code the confirmation reads, and on extracted_at; both gaps
// fail safe (a read wasted or missed, never a wrong row). A hybrid's estimate
// (CBAPI, listed under CBA) is read again on every new CBA extraction,
// though its documents are CBAPI's. A document that rehome_shared_extractions
// (services/report-extractor/extract.py) moves to the estimate's code keeps
// its extracted_at, so it never triggers a read: that estimate waits for the
// next extraction of its code, or a parser bump. A detail with no due date
// never matches (COALESCE): a NULL there would select the notice.
const (
	pendingNoticesSql = `
SELECT stock_code, announcement_date::text, headline, pdf_url, listed_codes FROM (
  SELECT DISTINCT ON (a.pdf_url) a.stock_code, a.announcement_date, a.headline, a.pdf_url,
    array_agg(a.stock_code) OVER (PARTITION BY a.pdf_url) AS listed_codes
  FROM asx_announcements a
  WHERE a.headline ILIKE '%Dividend/Distribution - %'
    AND a.pdf_url IS NOT NULL AND a.pdf_url <> ''
    AND NOT EXISTS (
      SELECT 1 FROM dividend_notice_attempts t
      WHERE t.announcement_url = a.pdf_url
        AND NOT (t.outcome = 'no_text' AND t.attempted_at < now() - interval '7 days')
        AND NOT (t.outcome NOT IN ('parsed', 'cancellation', 'scrip_only', 'no_text') AND t.parser_version < $2)
        AND NOT (t.outcome = 'estimated_only'
                 AND COALESCE(substring(t.detail from 'due ([0-9]{4}-[0-9]{2}-[0-9]{2})') < to_char(current_date, 'YYYY-MM-DD'), false)
                 AND EXISTS (SELECT 1 FROM financial_report_extractions e
                             WHERE e.stock_code = t.stock_code AND e.extracted_at > t.attempted_at
                               AND e.metrics ? 'dividend' AND e.document_meta ? 'period_end')))
  ORDER BY a.pdf_url, a.announcement_date DESC, a.stock_code
) s
ORDER BY announcement_date DESC, stock_code
LIMIT $1
`

	// upsertDividendInsert is what the two upserts share; each adds its own
	// WHERE, which decides whether an existing row is replaced.
	upsertDividendInsert = `
INSERT INTO dividend_history (stock_code, ex_date, record_date, payment_date, period_end, amount_per_share,
    franking_percentage, dividend_type, declared_currency, declared_amount, announcement_url, announced_on)
VALUES ($1, $2::date, NULLIF($3, '')::date, NULLIF($4, '')::date, NULLIF($5, '')::date, $6, $7, $8, $9, $10, $11, NULLIF($12, '')::date)
ON CONFLICT (stock_code, ex_date, dividend_type) DO UPDATE SET
    record_date = EXCLUDED.record_date, payment_date = EXCLUDED.payment_date, period_end = EXCLUDED.period_end,
    amount_per_share = EXCLUDED.amount_per_share, franking_percentage = EXCLUDED.franking_percentage,
    declared_currency = EXCLUDED.declared_currency, declared_amount = EXCLUDED.declared_amount,
    announcement_url = EXCLUDED.announcement_url, announced_on = EXCLUDED.announced_on
`

	upsertDividendSql = upsertDividendInsert + `WHERE dividend_history.announced_on IS NULL OR EXCLUDED.announced_on >= dividend_history.announced_on
`

	// upsertConfirmedEstimateSql replaces the notice's own row, or a confirmed
	// estimate from a notice announced on an earlier day (its attempt says
	// so), and nothing else: never a row stored from a declared amount,
	// whatever its date, NULL included. The pass checks the same before
	// writing (confirmEstimatedNotice); this holds if a declared row arrives
	// under the same ex-date in between. A row for the period under another
	// ex-date is no conflict here: what keeps the estimate from being stored
	// beside it is the pass's check of the stored rows, and the later-notice
	// rule (a later notice whose attempt is not yet recorded withholds it).
	upsertConfirmedEstimateSql = upsertDividendInsert + `WHERE dividend_history.announcement_url = EXCLUDED.announcement_url
   OR (dividend_history.announced_on < EXCLUDED.announced_on
       AND EXISTS (SELECT 1 FROM dividend_notice_attempts t
                   WHERE t.announcement_url = dividend_history.announcement_url
                     AND t.outcome = 'parsed' AND t.detail LIKE '%` + confirmedEstimateMarker + `%'))
`

	recordAttemptSql = `
INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version, attempted_at)
VALUES ($1, $2, $3, NULLIF($4, ''), $5, now())
ON CONFLICT (announcement_url) DO UPDATE SET stock_code = EXCLUDED.stock_code, outcome = EXCLUDED.outcome,
    detail = EXCLUDED.detail, parser_version = EXCLUDED.parser_version, attempted_at = EXCLUDED.attempted_at
`

	// estimateDocumentsSql: the extractions of an estimate's security code
	// ($1, the notice's own: a hybrid's is never its issuer's) that carry a
	// dividend, as ConfirmEstimate reads them.
	estimateDocumentsSql = `
SELECT e.stock_code, e.report_url, COALESCE(e.report_title, ''), COALESCE(to_char(e.report_date, 'YYYY-MM-DD'), ''),
       COALESCE(cm.company_name, ''), e.document_meta, e.metrics->'dividend'
FROM financial_report_extractions e
LEFT JOIN "company-metadata" cm ON cm.stock_code = e.stock_code
WHERE e.stock_code = $1 AND e.metrics ? 'dividend'
ORDER BY e.report_date, e.report_url
`

	// estimateStoredSql: the rows stored for an estimate's code ($1) under its
	// ex-date ($2) or for its 2A.3 period end ($3) under any ex-date (a
	// re-lodged notice that moved the ex-date: KME's 2026-09-30 and 10-01 are
	// both stored), each with whether its notice is itself a confirmed
	// estimate. The period also withholds an estimate when an issuer states
	// one period end for two distributions, which fails safe: LFG's 03099463
	// (7.5c, ex 2026-06-04) and 03128689 (7.4986c, ex 2026-06-29) both state
	// 2A.3 2026-06-30. So a review flag for a period stored under two
	// ex-dates must match a re-lodged notice, never the period alone: KME's,
	// KSL's and N1H's pairs repeat the amount (KSL's and N1H's the payment
	// date too; KME's moved it), LFG's do not.
	estimateStoredSql = `
SELECT COALESCE(d.dividend_type, ''), d.ex_date::text, COALESCE(d.announcement_url, ''), COALESCE(d.announced_on::text, ''),
       EXISTS (SELECT 1 FROM dividend_notice_attempts t
               WHERE t.announcement_url = d.announcement_url
                 AND t.outcome = 'parsed' AND t.detail LIKE '%` + confirmedEstimateMarker + `%')
FROM dividend_history d
WHERE d.stock_code = $1 AND (d.ex_date = $2::date OR d.period_end = NULLIF($3, '')::date)
ORDER BY d.ex_date, d.dividend_type, d.announcement_url
`

	// estimateLaterNoticesSql: every other notice ($1 is the estimate's)
	// listed under a code that shares the security code's first three
	// characters ($2), announced on or after the estimate's day ($3; which of
	// a day's notices came later is lodgedAfter's), with its latest
	// announcement date, its attempt, and whether it stored a row for the
	// code under the ex-date ($4) or for the period end ($5) with one of the
	// estimate's types ($6). The code range, not left(stock_code, 3), lets the
	// scan use idx_asx_ann_stock_date (0.25 ms against 113 ms on prod,
	// 2026-10-13); ASX codes are capital letters and digits.
	estimateLaterNoticesSql = `
SELECT l.pdf_url, l.announced::text, COALESCE(t.outcome, ''), COALESCE(t.detail, ''),
       EXISTS (SELECT 1 FROM dividend_history d
               WHERE d.announcement_url = l.pdf_url AND d.stock_code = $2
                 AND (d.ex_date = $4::date OR d.period_end = NULLIF($5, '')::date AND d.dividend_type = ANY($6::text[])))
FROM (SELECT a.pdf_url, max(a.announcement_date) AS announced FROM asx_announcements a
      WHERE a.stock_code BETWEEN upper(left($2, 3)) AND upper(left($2, 3)) || 'ZZZZZZZZZZ'
        AND a.announcement_date >= $3::date
        AND a.headline ILIKE '%Dividend/Distribution - %'
        AND a.pdf_url IS NOT NULL AND a.pdf_url <> '' AND a.pdf_url <> $1
      GROUP BY a.pdf_url) l
LEFT JOIN dividend_notice_attempts t ON t.announcement_url = l.pdf_url
ORDER BY l.pdf_url
`
)

// dividendNoticeDB is what the store asks of its *pgxpool.Pool. A test
// records the statements and their arguments without a database.
type dividendNoticeDB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// postgresDividendNoticeStore implements dividendNoticeStore.
type postgresDividendNoticeStore struct {
	db dividendNoticeDB
}

// PendingDividendNotices returns up to limit unparsed dividend notices.
func (s *postgresDividendNoticeStore) PendingDividendNotices(ctx context.Context, limit int, parserVersion int) ([]pendingNotice, error) {
	rows, err := s.db.Query(ctx, pendingNoticesSql, limit, parserVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []pendingNotice
	for rows.Next() {
		var p pendingNotice
		if err := rows.Scan(&p.StockCode, &p.AnnouncementDate, &p.Headline, &p.URL, &p.ListedCodes); err != nil {
			return nil, err
		}
		sort.Strings(p.ListedCodes)
		result = append(result, p)
	}
	return result, rows.Err()
}

// UpsertDividends inserts or updates dividend rows, returning the number affected.
func (s *postgresDividendNoticeStore) UpsertDividends(ctx context.Context, rows []dividendRow) (int, error) {
	return s.upsert(ctx, upsertDividendSql, rows)
}

// UpsertConfirmedEstimates inserts rows a results document confirmed,
// replacing only the notice's own row or an earlier confirmed estimate, and
// returns the number affected.
func (s *postgresDividendNoticeStore) UpsertConfirmedEstimates(ctx context.Context, rows []dividendRow) (int, error) {
	return s.upsert(ctx, upsertConfirmedEstimateSql, rows)
}

func (s *postgresDividendNoticeStore) upsert(ctx context.Context, sql string, rows []dividendRow) (int, error) {
	var totalRows int
	for _, row := range rows {
		cmdTag, err := s.db.Exec(ctx, sql,
			row.StockCode, row.ExDate, row.RecordDate, row.PaymentDate, row.PeriodEnd,
			row.AmountAUD, row.FrankedPct, row.Type, row.DeclaredCurrency, row.DeclaredAmount,
			row.AnnouncementURL, row.AnnouncedOn)
		if err != nil {
			return totalRows, err
		}
		totalRows += int(cmdTag.RowsAffected())
	}
	return totalRows, nil
}

// EstimateEvidence reads, for an estimated_only notice, the extractions of
// its security code, the rows stored for its code under its ex-date or for
// its period, and the issuer's notices announced since (estimateEvidence).
func (s *postgresDividendNoticeStore) EstimateEvidence(ctx context.Context, n DividendNotice, p pendingNotice) (estimateEvidence, error) {
	var ev estimateEvidence
	docs, err := s.db.Query(ctx, estimateDocumentsSql, n.SecurityCode)
	if err != nil {
		return ev, fmt.Errorf("documents: %w", err)
	}
	for docs.Next() {
		var d ResultsDocument
		var meta, dividend []byte
		if err := docs.Scan(&d.StockCode, &d.URL, &d.Title, &d.ReportDate, &d.CompanyName, &meta, &dividend); err != nil {
			docs.Close()
			return ev, fmt.Errorf("documents: %w", err)
		}
		d.DocumentMeta, d.Dividend = meta, dividend
		ev.Documents = append(ev.Documents, d)
	}
	docs.Close()
	if err := docs.Err(); err != nil {
		return ev, fmt.Errorf("documents: %w", err)
	}

	stored, err := s.db.Query(ctx, estimateStoredSql, n.SecurityCode, n.ExDate, n.PeriodEnd)
	if err != nil {
		return ev, fmt.Errorf("stored rows: %w", err)
	}
	for stored.Next() {
		var r storedDividend
		if err := stored.Scan(&r.Type, &r.ExDate, &r.AnnouncementURL, &r.AnnouncedOn, &r.ConfirmedEstimate); err != nil {
			stored.Close()
			return ev, fmt.Errorf("stored rows: %w", err)
		}
		ev.Stored = append(ev.Stored, r)
	}
	stored.Close()
	if err := stored.Err(); err != nil {
		return ev, fmt.Errorf("stored rows: %w", err)
	}

	var types []string
	for _, part := range n.Parts {
		types = append(types, part.Type)
	}
	later, err := s.db.Query(ctx, estimateLaterNoticesSql, p.URL, n.SecurityCode, p.AnnouncementDate, n.ExDate, n.PeriodEnd, types)
	if err != nil {
		return ev, fmt.Errorf("later notices: %w", err)
	}
	defer later.Close()
	for later.Next() {
		var l laterNotice
		if err := later.Scan(&l.URL, &l.AnnouncedOn, &l.Outcome, &l.Detail, &l.StoredDividend); err != nil {
			return ev, fmt.Errorf("later notices: %w", err)
		}
		ev.Later = append(ev.Later, l)
	}
	if err := later.Err(); err != nil {
		return ev, fmt.Errorf("later notices: %w", err)
	}
	return ev, nil
}

// RecordNoticeAttempt records the outcome of processing one notice.
func (s *postgresDividendNoticeStore) RecordNoticeAttempt(ctx context.Context, a noticeAttempt) error {
	_, err := s.db.Exec(ctx, recordAttemptSql, a.URL, a.StockCode, a.Outcome, a.Detail, a.ParserVersion)
	return err
}
