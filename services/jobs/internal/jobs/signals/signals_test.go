package signals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func strp(s string) *string { return &s }

func TestRowsFromSignalsMapsPayload(t *testing.T) {
	payload := &signalsPayload{
		Adverse: []signal{{
			Headline:   "  Federal Court fines former execs  ",
			Kind:       strp("court"),
			Detail:     strp("money-laundering risk findings"),
			Date:       strp("2025-03-01"),
			Severity:   strp("high"),
			Citations:  json.RawMessage(`[{"url":"https://example.com/a"}]`),
			Confidence: func() *float64 { v := 0.82; return &v }(),
		}},
		Positive: []signal{
			{Headline: "Named employer of the year", Kind: strp("award")},
			{Headline: "   "}, // blank after trim: dropped (headline is NOT NULL + hashed)
		},
	}

	rows := rowsFromSignals("SGR", payload)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (blank headline dropped)", len(rows))
	}

	// Adverse first, then positive — the order collect.py wrote.
	if rows[0].Polarity != "adverse" || rows[1].Polarity != "positive" {
		t.Fatalf("polarity order = %q,%q", rows[0].Polarity, rows[1].Polarity)
	}
	got := rows[0]
	if got.Headline != "Federal Court fines former execs" {
		t.Errorf("headline not trimmed: %q", got.Headline)
	}
	if got.StockCode != "SGR" || *got.Kind != "court" || *got.EventDate != "2025-03-01" || *got.Severity != "high" {
		t.Errorf("unexpected column mapping: %+v", got)
	}
	if got.Confidence != 0.82 {
		t.Errorf("confidence = %v, want 0.82", got.Confidence)
	}
	if got.Citations != `[{"url":"https://example.com/a"}]` {
		t.Errorf("citations = %q", got.Citations)
	}
	// The hash is computed over the TRIMMED headline — it is the stored
	// dedupe key, so it must match sha1("code|polarity|headline").
	if want := contentHash("SGR", "adverse", "Federal Court fines former execs"); got.ContentHash != want {
		t.Errorf("content_hash = %q, want %q", got.ContentHash, want)
	}

	// Missing fields stay NULL / defaulted rather than becoming empty strings.
	pos := rows[1]
	if pos.Detail != nil || pos.EventDate != nil || pos.Severity != nil {
		t.Errorf("absent fields must stay NULL: %+v", pos)
	}
	if pos.Citations != "[]" {
		t.Errorf("absent citations = %q, want []", pos.Citations)
	}
	if pos.Confidence != 0 {
		t.Errorf("absent confidence = %v, want 0", pos.Confidence)
	}
}

func TestContentHashIsStableSHA1(t *testing.T) {
	// Pinned value: the (stock_code, content_hash) unique index in migration
	// 000052 holds rows written by collect.py's hashlib.sha1 of the same input.
	// Changing this silently duplicates every historical signal.
	got := contentHash("SGR", "adverse", "Federal Court fines former execs")
	const want = "b467318fc518b25f8e6b6e4b0b93fac94de9fcfa"
	if got != want {
		t.Errorf("contentHash = %q, want %q", got, want)
	}
}

func TestRowsFromSignalsNilPayload(t *testing.T) {
	if rows := rowsFromSignals("BHP", nil); rows != nil {
		t.Fatalf("rows = %v, want nil", rows)
	}
}

func TestCitationsJSONNormalisation(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"absent", "", "[]"},
		{"null", "null", "[]"},
		{"padded null", "  null  ", "[]"},
		{"array kept", `["a"]`, `["a"]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := citationsJSON(json.RawMessage(tt.raw)); got != tt.want {
				t.Errorf("citationsJSON(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestSelectStocksSQLPriority(t *testing.T) {
	top := selectStocksSQL(priorityTopShorted)
	if !strings.Contains(top, "JOIN mv_top_shorts t ON t.product_code = cm.stock_code") {
		t.Errorf("top-shorted must join mv_top_shorts:\n%s", top)
	}
	if !strings.Contains(top, "ORDER BY t.current_percent DESC NULLS LAST") {
		t.Errorf("top-shorted must order by short percent:\n%s", top)
	}

	enriched := selectStocksSQL(priorityEnriched)
	if strings.Contains(enriched, "mv_top_shorts") {
		t.Errorf("enriched must not join mv_top_shorts:\n%s", enriched)
	}
	if !strings.Contains(enriched, "ORDER BY (cm.enhanced_summary IS NOT NULL) DESC, cm.stock_code") {
		t.Errorf("enriched must order enriched-first:\n%s", enriched)
	}

	for name, sql := range map[string]string{"top-shorted": top, "enriched": enriched} {
		t.Run(name, func(t *testing.T) {
			// The freshness window and limit must be bind parameters, never
			// interpolated, and the company-name guard must survive.
			if !strings.Contains(sql, "($1 || ' days')::interval") || !strings.Contains(sql, "LIMIT $2") {
				t.Errorf("selection must be parameterised:\n%s", sql)
			}
			if !strings.Contains(sql, `COALESCE(cm.company_name,'') <> ''`) {
				t.Errorf("selection must require a company name:\n%s", sql)
			}
			if !strings.Contains(sql, "NOT EXISTS") || !strings.Contains(sql, "stock_signals_runs") {
				t.Errorf("selection must skip recently swept stocks:\n%s", sql)
			}
		})
	}
}

func TestInsertSignalsSQLBindsEveryValue(t *testing.T) {
	rows := []signalRow{
		{StockCode: "AAA", Polarity: "adverse", Headline: "h1", Citations: "[]", Confidence: 0.5, ContentHash: "hash1"},
		{StockCode: "AAA", Polarity: "positive", Headline: "h2", Citations: "[]", Confidence: 0.25, ContentHash: "hash2"},
	}
	sql, args := insertSignalsSQL(rows)
	if len(args) != 20 {
		t.Fatalf("args = %d, want 20 (2 rows × 10 columns)", len(args))
	}
	if !strings.Contains(sql, "($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)") ||
		!strings.Contains(sql, "($11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)") {
		t.Errorf("placeholder blocks wrong:\n%s", sql)
	}
	if !strings.Contains(sql, "ON CONFLICT (stock_code, content_hash) DO UPDATE SET") {
		t.Errorf("missing idempotent upsert:\n%s", sql)
	}
	// No caller value may reach the statement text.
	if strings.Contains(sql, "hash1") || strings.Contains(sql, "h1") {
		t.Errorf("row values leaked into SQL text:\n%s", sql)
	}
	if args[0] != "AAA" || args[9] != "hash1" || args[10] != "AAA" || args[19] != "hash2" {
		t.Errorf("arg order wrong: %v", args)
	}
}

func TestDedupeByHashKeepsLast(t *testing.T) {
	rows := []signalRow{
		{ContentHash: "a", Detail: strp("first")},
		{ContentHash: "b"},
		{ContentHash: "a", Detail: strp("second")},
	}
	got := dedupeByHash(rows)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].ContentHash != "a" || *got[0].Detail != "second" {
		t.Errorf("want last-write-wins in first position, got %+v", got[0])
	}
	if got[1].ContentHash != "b" {
		t.Errorf("order not preserved: %+v", got)
	}
}

func TestCountPolarities(t *testing.T) {
	a, p := countPolarities([]signalRow{
		{Polarity: "adverse"}, {Polarity: "positive"}, {Polarity: "adverse"},
	})
	if a != 2 || p != 1 {
		t.Fatalf("counts = %d adverse, %d positive; want 2, 1", a, p)
	}
}

// --- brandbrain client -------------------------------------------------------

func TestResolveRetriesOn5xxThenSucceeds(t *testing.T) {
	var calls int32
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"adverse":[{"headline":"x"}],"positive":[]}`))
	}))
	defer srv.Close()

	c := &brandbrainClient{url: srv.URL, http: srv.Client(), retries: 3}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	payload, err := c.Resolve(ctx, "Star Entertainment")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if len(payload.Adverse) != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2 (one 502 retried)", calls)
	}
	// The request body is collect.py's exact shape.
	var req map[string]string
	if err := json.Unmarshal(gotBody, &req); err != nil {
		t.Fatalf("request body not JSON: %v (%s)", err, gotBody)
	}
	if req["business_name"] != "Star Entertainment" || req["state"] != "" {
		t.Errorf("request body = %v", req)
	}
}

func TestResolveDoesNotRetry4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer srv.Close()

	c := &brandbrainClient{url: srv.URL, http: srv.Client(), retries: 3}
	if _, err := c.Resolve(context.Background(), "ACME"); err == nil {
		t.Fatal("want an error for HTTP 400")
	} else if !strings.Contains(err.Error(), "400") {
		t.Errorf("error = %v, want the status in it", err)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 (4xx is terminal)", calls)
	}
}

func TestResolveGivesUpAfterRetries(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	// retries=2 keeps the single backoff at 1s.
	c := &brandbrainClient{url: srv.URL, http: srv.Client(), retries: 2}
	if _, err := c.Resolve(context.Background(), "ACME"); err == nil {
		t.Fatal("want an error after exhausting retries")
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
}

func TestResolveStopsOnCancelledContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	c := &brandbrainClient{url: srv.URL, http: srv.Client(), retries: 3}
	cancel()
	start := time.Now()
	if _, err := c.Resolve(ctx, "ACME"); err == nil {
		t.Fatal("want an error on a cancelled context")
	}
	// A cancelled context must not sit out the backoff sleep.
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("took %s; backoff ignored cancellation", elapsed)
	}
}

func TestBackoffSchedule(t *testing.T) {
	// collect.py: time.sleep(2**attempt + attempt) → 1s then 3s.
	if got := backoff(0); got != time.Second {
		t.Errorf("backoff(0) = %s, want 1s", got)
	}
	if got := backoff(1); got != 3*time.Second {
		t.Errorf("backoff(1) = %s, want 3s", got)
	}
}

// --- sweep -------------------------------------------------------------------

type fakeResolver struct {
	mu      sync.Mutex
	calls   []string
	byName  map[string]*signalsPayload
	failFor map[string]error
	// inflight/peak track the observed concurrency.
	inflight, peak int
}

func (f *fakeResolver) Resolve(_ context.Context, name string) (*signalsPayload, error) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.inflight++
	if f.inflight > f.peak {
		f.peak = f.inflight
	}
	f.mu.Unlock()

	time.Sleep(5 * time.Millisecond) // widen the concurrency window
	defer func() {
		f.mu.Lock()
		f.inflight--
		f.mu.Unlock()
	}()

	if err, ok := f.failFor[name]; ok {
		return nil, err
	}
	return f.byName[name], nil
}

type fakeStore struct {
	mu     sync.Mutex
	stored map[string][]signalRow
}

func (s *fakeStore) Store(_ context.Context, code string, rows []signalRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stored == nil {
		s.stored = map[string][]signalRow{}
	}
	s.stored[code] = rows
	return nil
}

func payloadWith(adverse, positive int) *signalsPayload {
	p := &signalsPayload{}
	for i := 0; i < adverse; i++ {
		p.Adverse = append(p.Adverse, signal{Headline: fmt.Sprintf("adverse %d", i)})
	}
	for i := 0; i < positive; i++ {
		p.Positive = append(p.Positive, signal{Headline: fmt.Sprintf("positive %d", i)})
	}
	return p
}

func TestSweepStoresEveryStockAndSurvivesOneFailure(t *testing.T) {
	stocks := []stock{
		{Code: "AAA", CompanyName: "Alpha Ltd"},
		{Code: "BBB", CompanyName: "Beta Ltd"},
		{Code: "CCC", CompanyName: "Gamma Ltd"},
	}
	res := &fakeResolver{
		byName: map[string]*signalsPayload{
			"Alpha Ltd": payloadWith(2, 1),
			"Gamma Ltd": payloadWith(0, 1),
		},
		failFor: map[string]error{"Beta Ltd": errors.New("brandbrain 502")},
	}
	store := &fakeStore{}

	if err := sweep(context.Background(), res, store, stocks, config{workers: 2}); err != nil {
		t.Fatalf("sweep() error = %v; a per-stock failure must not fail the run", err)
	}
	if len(res.calls) != 3 {
		t.Errorf("resolver calls = %d, want 3", len(res.calls))
	}
	if _, ok := store.stored["BBB"]; ok {
		t.Error("a failed resolve must not write a row")
	}
	if got := len(store.stored["AAA"]); got != 3 {
		t.Errorf("AAA rows = %d, want 3", got)
	}
	if got := len(store.stored["CCC"]); got != 1 {
		t.Errorf("CCC rows = %d, want 1", got)
	}
	if res.peak > 2 {
		t.Errorf("peak concurrency = %d, want <= workers (2)", res.peak)
	}
}

func TestSweepDryRunWritesNothing(t *testing.T) {
	stocks := []stock{{Code: "AAA", CompanyName: "Alpha Ltd"}}
	res := &fakeResolver{byName: map[string]*signalsPayload{"Alpha Ltd": payloadWith(1, 1)}}
	store := &fakeStore{}

	if err := sweep(context.Background(), res, store, stocks, config{workers: 1, dryRun: true}); err != nil {
		t.Fatalf("sweep() error = %v", err)
	}
	if len(res.calls) != 1 {
		t.Errorf("dry run must still resolve, calls = %d", len(res.calls))
	}
	if len(store.stored) != 0 {
		t.Errorf("dry run wrote %d stock(s)", len(store.stored))
	}
}

func TestSweepStopsOnCancellation(t *testing.T) {
	var stocks []stock
	for i := 0; i < 50; i++ {
		stocks = append(stocks, stock{Code: fmt.Sprintf("S%02d", i), CompanyName: fmt.Sprintf("Co %d", i)})
	}
	res := &fakeResolver{byName: map[string]*signalsPayload{}}
	store := &fakeStore{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := sweep(ctx, res, store, stocks, config{workers: 2})
	if err == nil {
		t.Fatal("want an error when the sweep is cancelled")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
	if len(res.calls) > 2 {
		t.Errorf("kept working after cancellation: %d calls", len(res.calls))
	}
}
