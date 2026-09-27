package sync

import (
	"context"
	"math"
	"os"
	"sort"
	"strconv"
	gosync "sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
)

// stockTimeout bounds one stock's sync, whatever it is waiting on. The
// slowest legitimate stock is a ten-year first fetch: five Yahoo chunks at 45s
// each at worst, their pacing, and an Alpha Vantage fallback, under five
// minutes. On 2026-09-27 the catch-up's first attempt reached its six-hour task
// timeout having brought at most ~1,700 stocks current, most of them one
// request each; its retry did the remaining 127 ten-year fetches in 28 minutes.
// Whatever held the first attempt, one stock can now cost a run at most this.
const stockTimeout = 6 * time.Minute

// snapshotEvery is how often, in stocks, a run publishes its report so far,
// so a run that is killed, or still going, can be read.
const snapshotEvery = 100

// slowestKept is how many of a run's slowest stocks the report names.
const slowestKept = 10

// ProviderStats is one provider's share of a run. Seconds is the time spent
// inside its requests, including the pauses between a long window's chunks.
type ProviderStats struct {
	Requests int     `json:"requests"`
	Answered int     `json:"answered"`
	NoData   int     `json:"no_data"`
	Failed   int     `json:"failed"`
	Seconds  float64 `json:"seconds"`
}

// StockTiming is one stock's sync: how long it took and how it ended.
type StockTiming struct {
	Code    string  `json:"code"`
	Seconds float64 `json:"seconds"`
	Outcome string  `json:"outcome"`
}

// runStats is where a run's time went. CI cannot read the job's logs, so a
// run that is slow has to say why in its report.
type runStats struct {
	mu        gosync.Mutex
	providers map[string]*ProviderStats
	paced     time.Duration
	slowest   []StockTiming
}

func newRunStats() *runStats {
	return &runStats{providers: make(map[string]*ProviderStats)}
}

type runStatsKey struct{}

// withRunStats carries a run's stats to the calls it makes. A context value
// rather than a field, because the API's single-stock sync shares the manager.
func withRunStats(ctx context.Context, s *runStats) context.Context {
	return context.WithValue(ctx, runStatsKey{}, s)
}

func runStatsFrom(ctx context.Context) *runStats {
	s, _ := ctx.Value(runStatsKey{}).(*runStats)
	return s
}

// request records one provider request. A nil receiver records nothing.
func (s *runStats) request(provider string, took time.Duration, records int, err error) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.providers[provider]
	if p == nil {
		p = &ProviderStats{}
		s.providers[provider] = p
	}
	p.Requests++
	p.Seconds += took.Seconds()
	switch {
	case err == nil && records > 0:
		p.Answered++
	case err == nil || providers.IsNoDataError(err):
		p.NoData++
	default:
		p.Failed++
	}
}

// wait records time spent holding a provider to its rate limit.
func (s *runStats) wait(d time.Duration) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.paced += d
	s.mu.Unlock()
}

// stock records one stock's sync, keeping the slowest.
func (s *runStats) stock(code string, took time.Duration, outcome string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.slowest = append(s.slowest, StockTiming{Code: code, Seconds: round1(took.Seconds()), Outcome: outcome})
	sort.SliceStable(s.slowest, func(i, j int) bool { return s.slowest[i].Seconds > s.slowest[j].Seconds })
	if len(s.slowest) > slowestKept {
		s.slowest = s.slowest[:slowestKept]
	}
}

// fill copies the stats into the report.
func (s *runStats) fill(r *RunReport) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r.Providers = make(map[string]ProviderStats, len(s.providers))
	for name, p := range s.providers {
		p := *p
		p.Seconds = round1(p.Seconds)
		r.Providers[name] = p
	}
	r.PacedSeconds = round1(s.paced.Seconds())
	r.Slowest = append([]StockTiming(nil), s.slowest...)
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// taskAttempt is the Cloud Run task attempt: 0, or the retry's number.
func taskAttempt() int {
	n, _ := strconv.Atoi(os.Getenv("CLOUD_RUN_TASK_ATTEMPT"))
	return n
}
