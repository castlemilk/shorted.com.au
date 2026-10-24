package alerts

import (
	"context"
	"log"
	"math"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// The detail an event carries beyond its figures: the company's logo, and for a
// stock the context the email shows around the chart. It is computed once, after
// Evaluate and before any row is committed, and stored in the event's payload. The
// email is built from that row, so a retry renders the same bytes.

const (
	// historyPoints caps a stock's history. Six months of trading days is about 130.
	historyPoints = 130
	// changeLookback is how many of the code's own readings back the change compares with.
	changeLookback = 20
)

// enrichSource is what enrichment reads. The store is the production source; a test
// injects one that fails, to show the events still go out.
type enrichSource interface {
	loadStockHistory(ctx context.Context, codes []string, newest Date) (map[string][]historyRow, error)
	deferredCodes(ctx context.Context, day Date) (map[string]bool, error)
}

// enrich fills the logos of every candidate's companies and the stock detail of each
// stock candidate. It is best effort: a failed read is logged and the events go out
// without the part that read would have filled, so enrichment never fails the run.
func (a *alertRun) enrich(ctx context.Context, cands []Candidate, snap *Snapshot, companies map[string]CompanyInfo) {
	enrichFrom(ctx, a.st, cands, snap, companies)
}

func enrichFrom(ctx context.Context, src enrichSource, cands []Candidate, snap *Snapshot, companies map[string]CompanyInfo) {
	for i := range cands {
		cs := cands[i].Payload.Companies
		for j := range cs {
			cs[j].LogoURL = companies[cs[j].Code].LogoURL
		}
	}

	var codes []string
	seen := map[string]bool{}
	var newest Date
	for _, c := range cands {
		if c.Monitor.Scope != alertevents.ScopeStock {
			continue
		}
		if !seen[c.Monitor.Target] {
			seen[c.Monitor.Target] = true
			codes = append(codes, c.Monitor.Target)
		}
		if c.ReportDate > newest {
			newest = c.ReportDate
		}
	}
	if len(codes) == 0 {
		return
	}
	// The rank leaves out the DEFERRED product lines. If that read fails, the rank
	// counts them: a wrong rank is shown with its date, and the alert still goes out.
	if deferred, err := src.deferredCodes(ctx, newest); err != nil {
		log.Printf("alerts: rank without the DEFERRED exclusion: %v", err)
	} else {
		snap.unranked = deferred
	}
	hist, err := src.loadStockHistory(ctx, codes, newest)
	if err != nil {
		log.Printf("alerts: enrichment skipped, events go out without the stock detail: %v", err)
		return
	}
	for i := range cands {
		c := &cands[i]
		if c.Monitor.Scope != alertevents.ScopeStock {
			continue
		}
		code := c.Monitor.Target
		c.Payload.Stock = stockDetailOf(snap, code, companies[code], hist[code], c.ReportDate)
	}
}

// stockDetailOf builds one stock event's detail from the code's readings, oldest
// first. Only readings on or before report are used, so an older event is not
// given later history. It returns nil when report has no reading for the code.
//
// The change compares with the code's own reading 20 readings back, which can be
// months earlier for a code reported on some days only. Change20Date names that day.
// The snapshot holds only the newest 20 dates, one short of the 21 needed, so the
// comparison is read from the history instead. The two agree for any code reported
// on every date, which the ASIC data is for listed companies.
func stockDetailOf(snap *Snapshot, code string, info CompanyInfo, rows []historyRow, report Date) *alertevents.StockDetail {
	end := -1
	for i, r := range rows {
		if r.date <= report {
			end = i
		}
	}
	if end < 0 || rows[end].date != report {
		return nil
	}
	// A non-finite reading cannot be encoded in JSON, so it is dropped here as well as
	// in the query. The last reading is the report's own, so a non-finite one leaves
	// no detail at all.
	if !finite(rows[end].pct) {
		return nil
	}
	upTo := finiteReadings(rows[:end+1])
	last := upTo[len(upTo)-1]

	d := &alertevents.StockDetail{
		Name:          info.Name,
		Industry:      info.Industry,
		LogoURL:       info.LogoURL,
		SharesShort:   finitePtr(last.sharesShort),
		SharesOnIssue: finitePtr(last.sharesOnIss),
	}
	d.Rank, d.Ranked = snap.marketRank(code, report)
	n := len(upTo) - 1
	if n >= changeLookback {
		ref := upTo[n-changeLookback]
		change := round2(last.pct - ref.pct)
		d.Change20 = &change
		d.Change20Date = string(ref.date)
	}
	start := max(0, len(upTo)-historyPoints)
	for _, r := range upTo[start:] {
		d.History = append(d.History, alertevents.Point{D: string(r.date), P: round2(r.pct)})
	}
	return d
}

// finite reports whether v can be encoded in JSON and drawn.
func finite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// finiteReadings keeps the readings whose percent is finite, in order.
func finiteReadings(rows []historyRow) []historyRow {
	out := make([]historyRow, 0, len(rows))
	for _, r := range rows {
		if finite(r.pct) {
			out = append(out, r)
		}
	}
	return out
}

// finitePtr returns v, or nil when it is absent or not finite. A share count the
// report got wrong is unknown, never zero and never an encoding error.
func finitePtr(v *float64) *float64 {
	if v == nil || !finite(*v) {
		return nil
	}
	return v
}
