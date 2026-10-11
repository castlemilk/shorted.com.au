package announcements

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// pendingNotice represents an unparsed dividend notice from the crawl.
type pendingNotice struct {
	StockCode        string // the code whose announcements page listed it
	AnnouncementDate string // YYYY-MM-DD
	Headline         string
	URL              string // asx_announcements.pdf_url
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
}

// dividendPassResult is the tally returned by runDividendNoticePass.
type dividendPassResult struct {
	Selected, Parsed, Rows int
	Outcomes               map[string]int
}

// dividendNoticeStore is the interface between the pass and storage.
type dividendNoticeStore interface {
	PendingDividendNotices(ctx context.Context, limit int) ([]pendingNotice, error)
	UpsertDividends(ctx context.Context, rows []dividendRow) (int, error)
	RecordNoticeAttempt(ctx context.Context, a noticeAttempt) error
}

// noticeTextFunc fetches the text of an announcement PDF.
type noticeTextFunc func(ctx context.Context, url string) string

// dividendRowsFor extracts dividend rows from a parsed notice, applying policy.
// Policy:
//  1. SecurityCode and pendingNotice.StockCode must share their first 3 chars
//     (case-insensitive), else outcome "code_mismatch".
//  2. Drop parts with Estimated==true; if none remain, outcome "estimated_only".
//  3. Currency: if AUD, each row's AmountAUD is the part's Amount. If foreign:
//     - nil AUDEquivalent -> outcome "awaiting_aud_equivalent"
//     - more than one part -> outcome "foreign_multi_part"
//     - else AmountAUD = *n.AUDEquivalent
//  4. Rows: StockCode=n.SecurityCode, dates from notice, FrankedPct and Type
//     from part, DeclaredCurrency=n.Currency, DeclaredAmount=part.Amount,
//     AnnouncementURL=p.URL, AnnouncedOn=n.AnnouncedOn or p.AnnouncementDate.
//     Outcome "parsed" with detail like "2 rows".
func dividendRowsFor(n DividendNotice, p pendingNotice) (rows []dividendRow, outcome, detail string) {
	// Rule 1: code match (first 3 chars, case-insensitive)
	if len(n.SecurityCode) < 3 || len(p.StockCode) < 3 ||
		!strings.EqualFold(n.SecurityCode[:3], p.StockCode[:3]) {
		return nil, "code_mismatch", fmt.Sprintf("notice is for %s, listed under %s", n.SecurityCode, p.StockCode)
	}

	// Rule 2: drop estimated parts
	var parts []DividendPart
	for _, part := range n.Parts {
		if !part.Estimated {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return nil, "estimated_only", ""
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
				return nil, "awaiting_aud_equivalent", ""
			}
			if len(parts) > 1 {
				return nil, "foreign_multi_part", ""
			}
			amountAUD = *n.AUDEquivalent
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
	pending, err := store.PendingDividendNotices(ctx, limit)
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
		a := noticeAttempt{URL: n.URL, StockCode: n.StockCode, Outcome: outcome, Detail: detail}
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

// SQL const for pending notices (deduped, excluding recent attempts).
const (
	pendingNoticesSql = `
SELECT stock_code, announcement_date::text, headline, pdf_url FROM (
  SELECT DISTINCT ON (a.pdf_url) a.stock_code, a.announcement_date, a.headline, a.pdf_url
  FROM asx_announcements a
  WHERE a.headline ILIKE '%Dividend/Distribution - %'
    AND a.pdf_url IS NOT NULL AND a.pdf_url <> ''
    AND NOT EXISTS (
      SELECT 1 FROM dividend_notice_attempts t
      WHERE t.announcement_url = a.pdf_url
        AND (t.outcome <> 'no_text' OR t.attempted_at > now() - interval '7 days'))
  ORDER BY a.pdf_url, a.announcement_date DESC
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
INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, attempted_at)
VALUES ($1, $2, $3, NULLIF($4, ''), now())
ON CONFLICT (announcement_url) DO UPDATE SET stock_code = EXCLUDED.stock_code, outcome = EXCLUDED.outcome,
    detail = EXCLUDED.detail, attempted_at = EXCLUDED.attempted_at
`
)

// postgresDividendNoticeStore implements dividendNoticeStore.
type postgresDividendNoticeStore struct {
	db *pgxpool.Pool
}

// PendingDividendNotices returns up to limit unparsed dividend notices.
func (s *postgresDividendNoticeStore) PendingDividendNotices(ctx context.Context, limit int) ([]pendingNotice, error) {
	rows, err := s.db.Query(ctx, pendingNoticesSql, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []pendingNotice
	for rows.Next() {
		var p pendingNotice
		if err := rows.Scan(&p.StockCode, &p.AnnouncementDate, &p.Headline, &p.URL); err != nil {
			return nil, err
		}
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
	_, err := s.db.Exec(ctx, recordAttemptSql, a.URL, a.StockCode, a.Outcome, a.Detail)
	return err
}
