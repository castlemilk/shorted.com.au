package announcements

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
const dividendNoticeParserVersion = 5

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

		rows = append(rows, dividendRow{
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
		})
	}

	return rows, "parsed", fmt.Sprintf("%d rows", len(rows))
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
	logf func(string, ...interface{}),
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
		if outcome != "parsed" {
			tally(outcome, 0)
			record(n, outcome, detail)
			return
		}
		if dryRun {
			for _, r := range rows {
				logf("DRY-RUN dividend: %s %s ex %s A$%.6f (declared %s %.6f) from %s", r.StockCode, r.Type, r.ExDate,
					r.AmountAUD, r.DeclaredCurrency, r.DeclaredAmount, n.URL)
			}
			tally("parsed", len(rows))
			return
		}
		written, err := store.UpsertDividends(ctx, rows)
		if err != nil {
			logf("dividend notice %s: upsert failed: %v", n.URL, err)
			tally("store_error", 0) // no attempt recorded, so it is retried next run
			return
		}
		tally("parsed", written)
		record(n, "parsed", detail)
	}

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
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
		}()
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
        AND NOT (t.outcome NOT IN ('parsed', 'cancellation', 'scrip_only', 'no_text') AND t.parser_version < $2))
  ORDER BY a.pdf_url, a.announcement_date DESC, a.stock_code
) s
ORDER BY announcement_date DESC, stock_code
LIMIT $1
`

	upsertDividendSql = `
INSERT INTO dividend_history (stock_code, ex_date, record_date, payment_date, period_end, amount_per_share,
    franking_percentage, dividend_type, declared_currency, declared_amount, announcement_url, announced_on)
VALUES ($1, $2::date, NULLIF($3, '')::date, NULLIF($4, '')::date, NULLIF($5, '')::date, $6, $7, $8, $9, $10, $11, NULLIF($12, '')::date)
ON CONFLICT (stock_code, ex_date, dividend_type) DO UPDATE SET
    record_date = EXCLUDED.record_date, payment_date = EXCLUDED.payment_date, period_end = EXCLUDED.period_end,
    amount_per_share = EXCLUDED.amount_per_share, franking_percentage = EXCLUDED.franking_percentage,
    declared_currency = EXCLUDED.declared_currency, declared_amount = EXCLUDED.declared_amount,
    announcement_url = EXCLUDED.announcement_url, announced_on = EXCLUDED.announced_on
WHERE dividend_history.announced_on IS NULL OR EXCLUDED.announced_on >= dividend_history.announced_on
`

	recordAttemptSql = `
INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version, attempted_at)
VALUES ($1, $2, $3, NULLIF($4, ''), $5, now())
ON CONFLICT (announcement_url) DO UPDATE SET stock_code = EXCLUDED.stock_code, outcome = EXCLUDED.outcome,
    detail = EXCLUDED.detail, parser_version = EXCLUDED.parser_version, attempted_at = EXCLUDED.attempted_at
`
)

// postgresDividendNoticeStore implements dividendNoticeStore.
type postgresDividendNoticeStore struct {
	db *pgxpool.Pool
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
	if len(rows) == 0 {
		return 0, nil
	}

	var totalRows int
	for _, row := range rows {
		cmdTag, err := s.db.Exec(ctx, upsertDividendSql,
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

// RecordNoticeAttempt records the outcome of processing one notice.
func (s *postgresDividendNoticeStore) RecordNoticeAttempt(ctx context.Context, a noticeAttempt) error {
	_, err := s.db.Exec(ctx, recordAttemptSql, a.URL, a.StockCode, a.Outcome, a.Detail, a.ParserVersion)
	return err
}
