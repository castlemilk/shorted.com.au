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

// PeriodRow.FieldSources values that are not a row source (plan
// fundamentals-coverage.md §2.2). The other two legal values are sourceMarkit
// and sourceFiling.
const (
	fieldSourceDerivedFCFMinusCapex = "derived:fcf-minus-capex"
	fieldSourceDerivedTTMAtFYE      = "derived:ttm-at-fye"
)

// PeriodRow is one stock_fundamentals row: one period of one stock's typed
// statement lines, in the REPORTING currency, exactly as the source reports
// them. A nil value is "the source did not report it", never zero.
//
// Every *float64 value field is listed once in fundamentalsColumns
// (columns.go), with its column name, unit and flow/balance kind; iterate that
// table rather than naming fields one by one.
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

	// The full statements (plan fundamentals-coverage.md §2.1, migration
	// 000132). Yahoo's sign convention: outflows are NEGATIVE. Flow lines are
	// always nil on a 'quarter' (balance snapshot) row.
	GrossProfit        *float64
	OperatingIncome    *float64 // absent for banks and insurers
	EBITDA             *float64 // statutory: impairments and revaluations in
	NormalizedEBITDA   *float64
	EBIT               *float64
	InterestExpense    *float64 // a positive expense
	PretaxIncome       *float64
	TaxProvision       *float64
	NetInterestIncome  *float64 // banks; minus interest expense for others, so not a classifier
	CapitalExpenditure *float64 // an outflow: <= 0
	DividendsPaid      *float64 // cash dividends paid: <= 0
	ShareBuybacks      *float64 // an outflow: <= 0
	// Balance sheet at PeriodEnd.
	TotalAssets             *float64
	TotalLiabilities        *float64
	TotalEquity             *float64
	CashAndEquivalents      *float64
	TotalDebt               *float64 // INCLUDES lease liabilities
	CapitalLeaseObligations *float64 // lease liabilities
	NetDebt                 *float64 // Yahoo's EXCLUDES leases and is omitted when <= 0
	CurrentAssets           *float64
	CurrentLiabilities      *float64

	Source string

	// FieldSources records ONLY the exceptions: column name -> where a value
	// that did not come from Source came from (sourceMarkit, sourceFiling,
	// fieldSourceDerivedFCFMinusCapex, fieldSourceDerivedTTMAtFYE). Keys are
	// fundamentalsColumns names. nil and empty mean the same thing: every
	// value is Source's (plan §2.2).
	FieldSources map[string]string
	// Rejected names the columns a sanity or currency gate refused for this
	// period (plan §3.4, §3.5). Their value is nil here, and the vendor upsert
	// writes NULL for them instead of keeping a stored value (plan §2.2 rule 2).
	Rejected []string
	// SourceDocumentURL and SourceDocumentDate name the filing a row (or its
	// filing-filled fields) came from; set only by the filings ingest.
	// SourceDocumentDate is midnight UTC, like PeriodEnd; nil when unknown.
	SourceDocumentURL  string
	SourceDocumentDate *time.Time
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

// values exposes the value fields by address, in fundamentalsColumns order,
// so sanitising and merging treat every column the same way and a new column
// cannot be forgotten in one place.
func (r *PeriodRow) values() []**float64 {
	out := make([]**float64, len(fundamentalsColumns))
	for i, c := range fundamentalsColumns {
		out[i] = c.field(r)
	}
	return out
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
