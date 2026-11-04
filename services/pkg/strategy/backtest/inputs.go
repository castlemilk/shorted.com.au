package backtest

import (
	"sort"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// Inputs is the read side of a run: every row the window reads. A run reads it
// twice, in pass 1 and pass 2, and holds the bars in memory between them, so an
// implementation must return the same rows on both reads. The reader that fills
// it from the database reads inside one REPEATABLE READ transaction.
type Inputs interface {
	// Codes lists the codes with rows in the window, in any order. Run sorts
	// them, so the order a caller returns them in never reaches an output.
	Codes() []string
	// Bars is the code's stock_prices rows, date ascending and unfiltered.
	Bars(code string) []features.Bar
	// Dividends is the code's dividend_history rows: unadjusted ex-dates.
	Dividends(code string) []features.Dividend
	// Fundamentals is the code's frozen fundamentals; the zero value when none.
	Fundamentals(code string) features.Fundamentals
	// Market is the market-wide rows.
	Market() Market
}

// Market holds the rows every code shares.
type Market struct {
	XJO, XJT []features.IndexBar
	ASIC     []features.ASICRow
	Ingests  []features.ReportIngest
	ETPs     map[string]bool
	Names    map[string]string
	// CashRate is the RBA cash rate target in percent, as stored (4.35 for
	// 4.35%), one point a month. Run forward-fills it to each session.
	CashRate []features.RatePoint
}

// MemoryInputs is an Inputs over maps the caller holds. The golden dataset and
// the tests read through it; the database reader is a second implementation.
type MemoryInputs struct {
	BarsByCode map[string][]features.Bar
	Divs       map[string][]features.Dividend
	Funds      map[string]features.Fundamentals
	Mkt        Market
}

// Codes returns the keys of BarsByCode, sorted.
func (m *MemoryInputs) Codes() []string {
	out := make([]string, 0, len(m.BarsByCode))
	for code := range m.BarsByCode {
		out = append(out, code)
	}
	sort.Strings(out)
	return out
}

// Bars returns the code's bars.
func (m *MemoryInputs) Bars(code string) []features.Bar { return m.BarsByCode[code] }

// Dividends returns the code's dividends.
func (m *MemoryInputs) Dividends(code string) []features.Dividend { return m.Divs[code] }

// Fundamentals returns the code's fundamentals.
func (m *MemoryInputs) Fundamentals(code string) features.Fundamentals { return m.Funds[code] }

// Market returns the market-wide rows.
func (m *MemoryInputs) Market() Market { return m.Mkt }
