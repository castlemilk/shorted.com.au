package picks

import (
	"context"
	"sync"
	"time"
)

// Period types stored in stock_fundamentals.period_type. No vendor we use
// carries half-year totals for ASX companies (Yahoo's quarterly P&L series are
// empty for the ASX); 'half' rows come only from company filings
// (-mode filings, filings_ingest.go). 'quarter' is allowed by the table's
// CHECK and written by nothing.
const (
	periodAnnual = "annual"
	periodHalf   = "half"
	periodTTM    = "ttm"
)

// Source identifiers stored in stock_fundamentals.source (VARCHAR(32)).
// Every source other than sourceFiling is a VENDOR for the filing conflict
// policy (filingUpsertSQL): a filing never overwrites a vendor's value.
const (
	sourceYahoo  = "yahoo-timeseries"
	sourceMarkit = "markit-key-statistics"
	sourceFiling = "asx-filing-extraction"
)

// PeriodRow is one stock_fundamentals row: one period of one stock's typed
// statement lines, in the REPORTING currency, exactly as the source reports
// them. A nil value is "the source did not report it", never zero.
type PeriodRow struct {
	PeriodType string    // periodAnnual | periodTTM | periodHalf (filings only)
	PeriodEnd  time.Time // the period's balance date, midnight UTC
	// FiscalYear is derived (assignFiscalYears), never taken from the source.
	FiscalYear        *int16
	Currency          string
	Revenue           *float64
	NetIncome         *float64
	EPSBasic          *float64
	EPSDiluted        *float64
	OperatingCashFlow *float64
	FreeCashFlow      *float64
	SharesOutstanding *float64
	Source            string
}

// hasValues reports whether any statement line is present.
func (r PeriodRow) hasValues() bool {
	for _, v := range r.values() {
		if *v != nil {
			return true
		}
	}
	return false
}

// values exposes the value fields by address, so sanitising and merging treat
// every column the same way and a new column cannot be forgotten in one place.
func (r *PeriodRow) values() []**float64 {
	return []**float64{
		&r.Revenue, &r.NetIncome, &r.EPSBasic, &r.EPSDiluted,
		&r.OperatingCashFlow, &r.FreeCashFlow, &r.SharesOutstanding,
	}
}

// Fetcher returns one code's per-period fundamentals.
//
// Contract: (rows, nil) with len(rows) == 0 means the source ANSWERED and
// publishes nothing for the code (an ETF, a new listing, a code it does not
// carry). An error means the source did not answer usefully (429, 5xx,
// transport failure, unparseable body) and says nothing about the code.
// The distinction decides the exit code: a market full of ETFs must not look
// like an outage, and an outage must not look like a market full of ETFs.
//
// The interface is the seam the plan (§2.7) keeps for a licensed source
// (EODHD) or the report-extractor reading Appendix 4D/4E PDFs.
type Fetcher interface {
	Name() string
	Fundamentals(ctx context.Context, code string) ([]PeriodRow, error)
}

// pacer spaces consecutive requests to one upstream by at least interval. The
// first request goes immediately. The wait is ctx-aware so SIGTERM lands
// promptly (jobs README convention 4).
type pacer struct {
	mu       sync.Mutex
	interval time.Duration
	last     time.Time
	now      func() time.Time
	sleep    func(ctx context.Context, d time.Duration) error
}

func newPacer(interval time.Duration) *pacer {
	return &pacer{interval: interval, now: time.Now, sleep: sleepCtx}
}

// wait blocks until interval has passed since the previous call returned.
func (p *pacer) wait(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.last.IsZero() {
		if d := p.interval - p.now().Sub(p.last); d > 0 {
			if err := p.sleep(ctx, d); err != nil {
				return err
			}
		}
	} else if err := ctx.Err(); err != nil {
		return err
	}
	p.last = p.now()
	return nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
