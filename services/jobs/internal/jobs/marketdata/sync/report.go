package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"regexp"
	"sort"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
)

// ReportObjectPrefix is where a run's report is stored in the job's bucket:
// gs://<bucket>/price-sync/<execution>.json. CI cannot read Cloud Logging
// (log access is project-level and deliberately not granted), so this object
// is how .github/workflows/price-sync.yml shows what a run did. That workflow
// reads this path; change both together.
const ReportObjectPrefix = "price-sync/"

// reportListCap bounds each list in the report. The counts are always exact.
const reportListCap = 200

// executionNamePattern is a Cloud Run execution name. The name arrives from the
// environment and becomes an object key, so it is validated first.
var executionNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// RunReport is what one sweep did.
type RunReport struct {
	Execution   string   `json:"execution,omitempty"`
	DryRun      bool     `json:"dry_run"`
	From        string   `json:"from,omitempty"`
	Codes       []string `json:"codes,omitempty"`
	LastSession string   `json:"last_session"`
	Duration    string   `json:"duration"`
	Error       string   `json:"error,omitempty"`

	Stocks int `json:"stocks"`
	// BeyondListing: how many of the stocks neither the ASX company listing nor
	// the top shorted carry (ETFs and other products), swept because they were
	// reported short or priced in the last recentDays. Scheduled runs only.
	BeyondListing int `json:"beyond_listing"`
	Synced        int `json:"synced"`
	UpToDate      int `json:"up_to_date"`
	// NoSession: the provider had no session in a window of at most
	// maxClosedWeekdays weekdays. A holiday, or a bar not yet published; not a
	// failure strike.
	NoSession int `json:"no_session"`
	// NoData: nothing in a longer window. A halt or a delisting; a strike
	// towards the failure tracker's block.
	NoData int `json:"no_data"`
	// Failed: every provider failed to answer (a 429, a 5xx, a timeout). No
	// strike; the stock stays stalest and is first in the next run.
	Failed  int `json:"failed"`
	Blocked int `json:"blocked"`

	Fetched int `json:"sessions_fetched"`
	Written int `json:"sessions_written"`

	// Set only with -from, which re-fetches sessions that are already stored:
	// how the provider's sessions compare with the stored ones.
	New               int            `json:"sessions_new,omitempty"`
	Changed           int            `json:"sessions_changed,omitempty"`
	ChangedTwofold    int            `json:"sessions_changed_twofold,omitempty"`
	StoredOnly        int            `json:"stored_only,omitempty"`
	StoredOnlyWeekend int            `json:"stored_only_weekend,omitempty"`
	StoredOnlyByCode  map[string]int `json:"stored_only_by_code,omitempty"`
	Changes           []PriceChange  `json:"changes,omitempty"`
	StoredOnlyRows    []StoredRow    `json:"stored_only_rows,omitempty"`
	// Every changed session, summarised: Changes keeps only the largest
	// ratios, and most damage is not large. A session filed a day early moves
	// by a day's move; a consolidation moves every session before it by the
	// same ratio. By month shows the first (it is seasonal: daylight time); by
	// code shows the second (a narrow ratio band ending on one date).
	ChangedByMonth map[string]int         `json:"changed_by_month,omitempty"`
	ChangedByCode  map[string]CodeChanges `json:"changed_by_code,omitempty"`

	FailedCodes []string `json:"failed_codes,omitempty"`
	NoDataCodes []string `json:"no_data_codes,omitempty"`

	// Where the time went: each provider's requests, the time spent holding
	// providers to their rate limits, and the slowest stocks.
	Providers    map[string]ProviderStats `json:"providers,omitempty"`
	PacedSeconds float64                  `json:"paced_seconds"`
	Slowest      []StockTiming            `json:"slowest,omitempty"`

	// Attempt is the Cloud Run task attempt: 0, or the retry after a failure
	// or a timeout. Each attempt's report is also kept on its own.
	Attempt int `json:"attempt"`
	// InProgress marks a report published while the run was still going.
	InProgress bool `json:"in_progress,omitempty"`
}

// PriceChange is a stored close that differs from the provider's for the same
// session.
type PriceChange struct {
	Code     string  `json:"code"`
	Date     string  `json:"date"`
	Stored   float64 `json:"stored"`
	Provider float64 `json:"provider"`
	// Ratio is the larger close over the smaller: 2 or more is not a revision
	// but a different security, a $0 bar or an unadjusted split.
	Ratio float64 `json:"ratio"`
}

// CodeChanges summarises one code's changed sessions.
type CodeChanges struct {
	Changed  int     `json:"changed"`
	Twofold  int     `json:"twofold,omitempty"`
	First    string  `json:"first"`
	Last     string  `json:"last"`
	MinRatio float64 `json:"min_ratio"`
	MaxRatio float64 `json:"max_ratio"`
}

// StoredRow is a stored session the provider does not have.
type StoredRow struct {
	Code  string  `json:"code"`
	Date  string  `json:"date"`
	Close float64 `json:"close"`
}

// priceDiff compares one stock's fetched sessions with its stored ones.
type priceDiff struct {
	new        int
	changes    []PriceChange
	storedOnly []StoredRow
}

// storedSession is one stored row's close, nil when NULL.
type storedSession struct {
	close *float64
}

// comparePrices diffs the provider's sessions against what is stored for the
// same window. A close counts as changed when it differs by more than storing
// it can explain: tolerance is half a unit of the column's last decimal
// (closeTolerance). No relative tolerance: a session filed a day early differs
// from the true one by a day's move, often well under one percent.
func comparePrices(code string, fetched []providers.PriceRecord, stored map[time.Time]storedSession, tolerance float64) priceDiff {
	var d priceDiff
	seen := make(map[time.Time]bool, len(fetched))
	for _, r := range fetched {
		seen[r.Date] = true
		s, ok := stored[r.Date]
		if !ok {
			d.new++
			continue
		}
		var have float64
		if s.close != nil {
			have = *s.close
		}
		if math.Abs(have-r.Close) <= tolerance {
			continue
		}
		d.changes = append(d.changes, PriceChange{
			Code: code, Date: r.Date.Format("2006-01-02"),
			Stored: have, Provider: r.Close, Ratio: closeRatio(have, r.Close),
		})
	}
	for date, s := range stored {
		if seen[date] {
			continue
		}
		row := StoredRow{Code: code, Date: date.Format("2006-01-02")}
		if s.close != nil {
			row.Close = *s.close
		}
		d.storedOnly = append(d.storedOnly, row)
	}
	sort.Slice(d.storedOnly, func(i, j int) bool { return d.storedOnly[i].Date < d.storedOnly[j].Date })
	return d
}

// closeTolerance is the most a stored close can differ from the provider's for
// storing alone: half a unit of the column's last decimal, and a little over.
// At two decimals (DECIMAL(10,2), until migration 000131) that is half a cent:
// 0.235 is stored as 0.24 by the database and 0.23 by a float round. At four it
// is half a hundredth of a cent, which is still wide of the float noise in the
// provider's values (43.45000076).
func closeTolerance(scale int) float64 {
	return 0.51 * math.Pow(10, -float64(scale))
}

// storedCloseTolerance is closeTolerance for the scale stock_prices.close has,
// so a comparison is right before and after migration 000131, whichever of it
// and this code reaches prod first.
func (m *SyncManager) storedCloseTolerance(ctx context.Context) float64 {
	var scale *int
	err := m.db.QueryRow(ctx, `
		SELECT numeric_scale FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'stock_prices' AND column_name = 'close'`).Scan(&scale)
	if err != nil || scale == nil {
		log.Printf("⚠️ could not read stock_prices.close's scale (%v); comparing to the cent", err)
		return closeTolerance(2)
	}
	return closeTolerance(*scale)
}

// ratioNoPrice is the ratio reported when a close is zero, negative or NULL
// (a stored $0 is the null-bar defect). Not +Inf: encoding/json refuses it, and
// the report would be lost with it. It ranks such rows first.
const ratioNoPrice = 1e9

// closeRatio is the larger of the two closes over the smaller.
func closeRatio(a, b float64) float64 {
	if a <= 0 || b <= 0 {
		return ratioNoPrice
	}
	return math.Max(a/b, b/a)
}

// addDiff folds one stock's comparison into the report.
func (r *RunReport) addDiff(d priceDiff) {
	r.New += d.new
	r.Changed += len(d.changes)
	for _, c := range d.changes {
		if c.Ratio >= 2 {
			r.ChangedTwofold++
		}
		if r.ChangedByMonth == nil {
			r.ChangedByMonth = make(map[string]int)
			r.ChangedByCode = make(map[string]CodeChanges)
		}
		r.ChangedByMonth[c.Date[:7]]++
		cc, seen := r.ChangedByCode[c.Code]
		cc.Changed++
		if c.Ratio >= 2 {
			cc.Twofold++
		}
		if !seen || c.Date < cc.First {
			cc.First = c.Date
		}
		if !seen || c.Date > cc.Last {
			cc.Last = c.Date
		}
		if !seen || c.Ratio < cc.MinRatio {
			cc.MinRatio = c.Ratio
		}
		if !seen || c.Ratio > cc.MaxRatio {
			cc.MaxRatio = c.Ratio
		}
		r.ChangedByCode[c.Code] = cc
	}
	r.Changes = append(r.Changes, d.changes...)
	sort.SliceStable(r.Changes, func(i, j int) bool { return r.Changes[i].Ratio > r.Changes[j].Ratio })
	if len(r.Changes) > reportListCap {
		r.Changes = r.Changes[:reportListCap]
	}

	for _, row := range d.storedOnly {
		r.StoredOnly++
		if t, err := time.Parse("2006-01-02", row.Date); err == nil && (t.Weekday() == time.Saturday || t.Weekday() == time.Sunday) {
			r.StoredOnlyWeekend++
		}
		if r.StoredOnlyByCode == nil {
			r.StoredOnlyByCode = make(map[string]int)
		}
		r.StoredOnlyByCode[row.Code]++
		if len(r.StoredOnlyRows) < reportListCap {
			r.StoredOnlyRows = append(r.StoredOnlyRows, row)
		}
	}
}

func appendCapped(list []string, code string) []string {
	if len(list) < reportListCap {
		return append(list, code)
	}
	return list
}

// log prints the report as a summary and, for a -from run, the comparison.
func (r *RunReport) log() {
	verb := "complete"
	if r.Error != "" {
		verb = "stopped"
	}
	log.Printf("🎉 Price sync %s in %s: %d stocks (%d beyond the company listing); %d synced (%d sessions fetched, %d written), %d already current, %d no session yet, %d no data, %d failed, %d blocked",
		verb, r.Duration, r.Stocks, r.BeyondListing, r.Synced, r.Fetched, r.Written, r.UpToDate, r.NoSession, r.NoData, r.Failed, r.Blocked)
	if r.From != "" {
		log.Printf("🔁 Against stored since %s: %d sessions new, %d changed (%d by 2x or more), %d stored sessions the provider does not have (%d on a weekend)",
			r.From, r.New, r.Changed, r.ChangedTwofold, r.StoredOnly, r.StoredOnlyWeekend)
		for i, c := range r.Changes {
			if i == 20 {
				break
			}
			log.Printf("   %s %s: stored %.4f, provider %.4f (x%.2f)", c.Code, c.Date, c.Stored, c.Provider, c.Ratio)
		}
	}
	for name, p := range r.Providers {
		log.Printf("⏱️ %s: %d requests (%d answered, %d no data, %d failed) in %.0fs", name, p.Requests, p.Answered, p.NoData, p.Failed, p.Seconds)
	}
	if len(r.Slowest) > 0 {
		log.Printf("⏱️ Waited %.0fs on rate limits; slowest stocks: %v", r.PacedSeconds, r.Slowest)
	}
	if r.Error != "" {
		log.Printf("❌ %s", r.Error)
	}
}

// publish stores the report at gs://<bucket>/price-sync/<execution>.json, and
// again under the attempt (reportObjects). It is best effort: the report
// describes the run and must not fail it.
func (r *RunReport) publish(ctx context.Context, gcs *storage.Client, bucket string) {
	execution, ok := reportExecution(gcs, bucket)
	if !ok {
		return
	}
	r.Execution = execution
	storeReport(ctx, gcs, bucket, execution, r.Attempt, r, !r.InProgress)
}

// publish stores a prune's report where a sweep's goes; its "mode" tells the
// workflow which it is.
func (r *PruneReport) publish(ctx context.Context, gcs *storage.Client, bucket string) {
	execution, ok := reportExecution(gcs, bucket)
	if !ok {
		return
	}
	r.Execution = execution
	storeReport(ctx, gcs, bucket, execution, r.Attempt, r, true)
}

// reportExecution is the Cloud Run execution a report is stored under, and
// whether there is anywhere to store it.
func reportExecution(gcs *storage.Client, bucket string) (string, bool) {
	execution := os.Getenv("CLOUD_RUN_EXECUTION")
	if gcs == nil || bucket == "" || !executionNamePattern.MatchString(execution) {
		return "", false // not a Cloud Run execution: nothing addressable to write
	}
	return execution, true
}

func storeReport(ctx context.Context, gcs *storage.Client, bucket, execution string, attempt int, report any, announce bool) {
	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		log.Printf("⚠️ report: %v", err)
		return
	}
	objects := reportObjects(execution, attempt)
	for _, object := range objects {
		if err := writeObject(ctx, gcs, bucket, object, body); err != nil {
			log.Printf("⚠️ report: gs://%s/%s: %v", bucket, object, err)
			return
		}
	}
	if announce {
		log.Printf("📄 Report: gs://%s/%s", bucket, objects[0])
	}
}

// reportObjects names where a report is stored: the execution's object, which
// the workflow reads and the latest attempt overwrites, and the attempt's own,
// which a retry cannot. The catch-up's first attempt did most of its work and
// then timed out, and its retry overwrote the only record of it.
func reportObjects(execution string, attempt int) []string {
	return []string{
		ReportObjectPrefix + execution + ".json",
		fmt.Sprintf("%s%s/attempt-%d.json", ReportObjectPrefix, execution, attempt),
	}
}

func writeObject(ctx context.Context, gcs *storage.Client, bucket, object string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	w := gcs.Bucket(bucket).Object(object).NewWriter(ctx)
	w.ContentType = "application/json"
	if _, err := w.Write(body); err != nil {
		_ = w.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	return nil
}

// describe is the run's options for the start-of-run log line.
func (o RunOptions) describe() string {
	s := ""
	if !o.From.IsZero() {
		s += fmt.Sprintf(", re-fetching from %s", o.From.Format("2006-01-02"))
	}
	if len(o.Codes) > 0 {
		s += fmt.Sprintf(", codes %v", o.Codes)
	}
	if o.Budget > 0 {
		s += fmt.Sprintf(", run budget %s", o.Budget)
	}
	if o.DryRun {
		s += ", DRY RUN (writes nothing)"
	}
	return s
}
