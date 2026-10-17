package sync

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/stocklist"
)

// recentDays is how recently a code must have been reported short, or priced,
// for a scheduled sweep to carry it when the ASX company listing does not.
const recentDays = 90

// recentlyReportedQuery lists every code in ASIC's short reports over the last
// recentDays days of reports.
var recentlyReportedQuery = fmt.Sprintf(`
	SELECT DISTINCT "PRODUCT_CODE"
	FROM shorts
	WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '%d days'
	  AND "PRODUCT_CODE" IS NOT NULL AND "PRODUCT_CODE" <> ''`, recentDays)

// beyondListing is what a scheduled sweep carries beyond the ASX company
// listing and the top shorted (listed, the list so far): every code ASIC has
// reported short in the last recentDays of reports, and every code holding a
// session within recentDays of the newest stored one.
//
// The listing is companies only. Without these an ETF (GDX, VAS, IOZ, STW) was
// never swept, and every one stopped on 2026-08-20 with the service this job
// replaced, which had reached them through its gap repair over every priced
// code. A shorted ETF never priced at all (NDQ, QUAL) is reached through the
// reports.
//
// Recent, not ever: a code last reported or priced years ago is delisted, and
// Yahoo holds nothing for a delisted ASX code (#591 measured 13 of 13), so a
// daily request for one cannot succeed. Both windows run from the newest data,
// not from today, so an outage cannot age a code out of the sweep that would
// repair it. A failed read of the reports costs only their codes.
func (m *SyncManager) beyondListing(ctx context.Context, listed []stocklist.Stock, latest map[string]time.Time, lastClosed time.Time) []stocklist.Stock {
	reported, err := m.recentlyReported(ctx)
	if err != nil {
		log.Printf("⚠️ Could not read the codes in recent short reports; sweeping without them: %v", err)
	}
	have := make(map[string]bool, len(listed))
	for _, s := range listed {
		have[s.Code] = true
	}
	var out []stocklist.Stock
	for _, c := range append(reported, recentlyPriced(latest, lastClosed)...) {
		c = strings.ToUpper(strings.TrimSpace(c))
		if c != "" && !have[c] {
			have[c] = true
			out = append(out, stocklist.Stock{Code: c})
		}
	}
	return out
}

// recentlyReported reads the codes in the last recentDays of short reports.
func (m *SyncManager) recentlyReported(ctx context.Context) ([]string, error) {
	rows, err := m.db.Query(ctx, recentlyReportedQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var codes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(codes)
	return codes, nil
}

// recentlyPriced lists the codes whose latest stored session is within
// recentDays of the newest one, sorted. The newest is capped at the last closed
// session, so a stray future-dated row cannot move the window past every code.
func recentlyPriced(latest map[string]time.Time, lastClosed time.Time) []string {
	var newest time.Time
	for _, d := range latest {
		if d.After(newest) {
			newest = d
		}
	}
	if newest.After(lastClosed) {
		newest = lastClosed
	}
	cutoff := utcDate(newest).AddDate(0, 0, -recentDays)
	var out []string
	for code, d := range latest {
		if !utcDate(d).Before(cutoff) {
			out = append(out, code)
		}
	}
	sort.Strings(out)
	return out
}
