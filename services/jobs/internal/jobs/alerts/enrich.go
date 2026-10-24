package alerts

import (
	"context"
	"log"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// The detail an event carries beyond its figures: the company's logo, and for a
// stock the context the email shows around the chart. It is computed once, after
// Evaluate and before any row is committed, and stored in the event's payload. The
// email is built from that row, so a retry renders the same bytes.

const (
	// historyPoints caps a stock's history. Six months of trading days is about 130.
	historyPoints = 130
	// changeLookback is how many report dates back the 20-day change compares with.
	changeLookback = 20
)

// enrich fills the logos of every candidate's companies and the stock detail of
// each stock candidate. It is best effort: a failed history read is logged and the
// events go out without the detail, so enrichment never fails the run.
func (a *alertRun) enrich(ctx context.Context, cands []Candidate, snap *Snapshot, companies map[string]CompanyInfo) {
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
	hist, err := a.st.loadStockHistory(ctx, codes, newest)
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
// The 20-day change compares with the code's own reading 20 of its reports earlier.
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
	upTo := rows[:end+1]
	last := upTo[end]

	d := &alertevents.StockDetail{
		Name:          info.Name,
		Industry:      info.Industry,
		LogoURL:       info.LogoURL,
		SharesShort:   last.sharesShort,
		SharesOnIssue: last.sharesOnIss,
	}
	d.Rank, d.Ranked = snap.marketRank(code, report)
	if end >= changeLookback {
		change := round2(last.pct - upTo[end-changeLookback].pct)
		d.Change20 = &change
	}
	start := max(0, len(upTo)-historyPoints)
	for _, r := range upTo[start:] {
		d.History = append(d.History, alertevents.Point{D: string(r.date), P: round2(r.pct)})
	}
	return d
}
