# Australian Economy Data Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One generic economic-series layer (migration 000081) fed by a new `services/economy-collector` (6 sources: RBA rates, ABS CPI/labour/trade-by-state/state-accounts, DCCEEW petroleum), exposed via two public RPCs and a `/economy` snapshot page, deployed as a Cloud Run Job wired into CI.

**Architecture:** SDMX-shaped catalog (`economic_series`) + observations table; a shared `services/pkg/absdata` package extracted from house-price-collector's proven ABS/RBA clients; the collector mirrors house-price-collector's `-mode` dispatch + pgx SimpleProtocol store; RPCs follow the housing handler chain (proto → handler → store interface → postgres impl → adapters/mocks); frontend follows the `/housing` SSR + `dynamic(ssr:false)` chart pattern.

**Tech Stack:** Go 1.26 (`github.com/castlemilk/shorted.com.au/services` module), pgx/pgxpool, excelize, Connect-RPC + buf, Next.js 14 App Router, visx, Terraform (Cloud Run Job + Scheduler).

**Spec:** `docs/superpowers/specs/2026-07-21-economy-data-platform-design.md`

**Working branch:** `feat/economy-data-platform` (already created; spec committed).

**Conventions that apply to every task:**
- Go tests are `package main` (collector) inline-fixture table tests, colocated `_test.go`, exercising pure `parseX` functions — no network in tests.
- All commits: `git commit --no-verify` is acceptable if the pre-commit hook wedges (known repo issue); prefer plain commit first.
- Run Go tests as `cd services && go test ./<dir>/... -run <Name> -v`.
- The rtk wrapper can report "Go build: Success" on failure — verify with `echo $?` or `go build -o /tmp/bin ./...`.

---

## Task 1: Migration 000081 — economic_series + economic_observations

**Files:**
- Create: `services/migrations/000081_add_economic_series.up.sql`
- Create: `services/migrations/000081_add_economic_series.down.sql`

- [ ] **Step 1: Write the up migration** (idempotent — prod applies by explicit `-f` file and may re-run):

```sql
-- 000081_add_economic_series.up.sql
-- Generic economic series layer (SDMX-shaped): catalog + observations.
-- Fed by services/economy-collector; read by ListEconomicSeries/GetEconomicSeries.

CREATE TABLE IF NOT EXISTS economic_series (
    id           BIGSERIAL PRIMARY KEY,
    series_key   TEXT UNIQUE NOT NULL,
    topic        TEXT NOT NULL,
    metric       TEXT NOT NULL,
    product      TEXT,
    region_type  TEXT NOT NULL,
    region_code  TEXT NOT NULL,
    region_name  TEXT NOT NULL,
    unit         TEXT NOT NULL,
    frequency    TEXT NOT NULL,
    adjustment   TEXT NOT NULL DEFAULT 'original',
    dimensions   JSONB NOT NULL DEFAULT '{}',
    source_key   TEXT NOT NULL,
    licence      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_economic_series_topic_metric
    ON economic_series (topic, metric);
CREATE INDEX IF NOT EXISTS idx_economic_series_source
    ON economic_series (source_key);

CREATE TABLE IF NOT EXISTS economic_observations (
    series_id  BIGINT NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
    period     DATE NOT NULL,
    value      DOUBLE PRECISION NOT NULL,
    UNIQUE (series_id, period)
);

CREATE INDEX IF NOT EXISTS idx_economic_obs_series_period
    ON economic_observations (series_id, period DESC);
```

- [ ] **Step 2: Write the down migration:**

```sql
-- 000081_add_economic_series.down.sql
DROP TABLE IF EXISTS economic_observations;
DROP TABLE IF EXISTS economic_series;
```

- [ ] **Step 3: Apply locally and verify**

Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' make migrate-up`
(Start the dev DB first with `make dev-db` from repo root if not running.)
Expected: migration applies. Verify: `psql postgresql://admin:password@localhost:5438/shorts -c "\d economic_series"` shows the table.

- [ ] **Step 4: Verify idempotency** — re-run the up file directly:

Run: `psql postgresql://admin:password@localhost:5438/shorts -f services/migrations/000081_add_economic_series.up.sql`
Expected: completes without error (all `IF NOT EXISTS`).

- [ ] **Step 5: Commit**

```bash
git add services/migrations/000081_add_economic_series.up.sql services/migrations/000081_add_economic_series.down.sql
git commit -m "feat(db): economic_series + economic_observations tables (000081)"
```

---

## Task 2: `services/pkg/absdata` — shared ABS SDMX + RBA CSV clients

Extract (copy, don't move — house-price-collector keeps its local copies per spec) the fetch/parse helpers into a shared package.

**Files:**
- Create: `services/pkg/absdata/absdata.go`
- Create: `services/pkg/absdata/rba.go`
- Create: `services/pkg/absdata/period.go`
- Test: `services/pkg/absdata/absdata_test.go`

- [ ] **Step 1: Write failing tests** for the pure helpers (`ColIndex`, `Code`, `Label`, `ApplyMult`, `PeriodDate`, `FindRBASeries`, `ParseRBADate`):

```go
package absdata

import (
	"testing"
	"time"
)

func TestColIndex(t *testing.T) {
	idx := ColIndex([]string{"DATAFLOW", "REGION: Region", "TIME_PERIOD: Time", "OBS_VALUE"})
	if idx["REGION"] != 1 || idx["OBS_VALUE"] != 3 {
		t.Fatalf("unexpected index map: %#v", idx)
	}
}

func TestCodeLabel(t *testing.T) {
	if Code("1: New South Wales") != "1" {
		t.Fatalf("Code failed")
	}
	if Label("1: New South Wales") != "New South Wales" {
		t.Fatalf("Label failed")
	}
	if Code("plain") != "plain" {
		t.Fatalf("Code passthrough failed")
	}
}

func TestApplyMult(t *testing.T) {
	if got := ApplyMult(5, "6: Millions"); got != 5e6 {
		t.Fatalf("ApplyMult = %v, want 5e6", got)
	}
	if got := ApplyMult(5, ""); got != 5 {
		t.Fatalf("ApplyMult empty = %v, want 5", got)
	}
}

func TestPeriodDate(t *testing.T) {
	cases := []struct {
		in       string
		wantDate string
		wantFreq string
		ok       bool
	}{
		{"2024", "2024-01-01", "annual", true},
		{"2024-Q3", "2024-07-01", "quarterly", true},
		{"2024-05", "2024-05-01", "monthly", true},
		{"garbage", "", "", false},
	}
	for _, c := range cases {
		d, freq, ok := PeriodDate(c.in)
		if ok != c.ok {
			t.Fatalf("%s: ok=%v want %v", c.in, ok, c.ok)
		}
		if ok && (d.Format("2006-01-02") != c.wantDate || freq != c.wantFreq) {
			t.Fatalf("%s: got %s/%s want %s/%s", c.in, d.Format("2006-01-02"), freq, c.wantDate, c.wantFreq)
		}
	}
}

func TestFindRBASeries(t *testing.T) {
	rows := [][]string{
		{"F1.1 Interest Rates"},
		{"Series ID", "FIRMMCRT", "FOOBAR"},
		{"04/06/2025", "3.85", "1.0"},
	}
	col, start, ok := FindRBASeries(rows, "FIRMMCRT")
	if !ok || col != 1 || start != 2 {
		t.Fatalf("FindRBASeries = %d,%d,%v", col, start, ok)
	}
	if _, _, ok := FindRBASeries(rows, "MISSING"); ok {
		t.Fatalf("expected miss")
	}
}

func TestParseRBADate(t *testing.T) {
	d, ok := ParseRBADate("04/06/2025")
	if !ok || !d.Equal(time.Date(2025, 6, 4, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("ParseRBADate slash form failed: %v %v", d, ok)
	}
	if _, ok := ParseRBADate("Jun-2025"); !ok {
		t.Fatalf("Mon-YYYY form failed")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services && go test ./pkg/absdata/... -v`
Expected: FAIL (package doesn't compile — functions undefined).

- [ ] **Step 3: Implement `absdata.go`** (SDMX client + CSV helpers, adapted from `house-price-collector/abs.go:18-118` with UA renamed):

```go
// Package absdata provides shared fetch + parse clients for ABS SDMX-CSV and
// RBA statistical-table CSV data. Extracted from house-price-collector; both
// endpoints WAF-block bare requests, so the User-Agent header is mandatory.
package absdata

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	absBase   = "https://data.api.abs.gov.au/rest/data"
	UserAgent = "shorted-data/1.0 (+https://shorted.com.au)"
	csvAccept = "application/vnd.sdmx.data+csv;labels=both"
	// Licence is the licence string for all ABS open data.
	Licence = "CC-BY-4.0"
)

// Client fetches ABS SDMX-CSV and RBA CSV tables.
type Client struct {
	http *http.Client
}

func NewClient() *Client {
	return &Client{http: &http.Client{Timeout: 60 * time.Second}}
}

// FetchSDMXCSV GETs one ABS dataflow as SDMX-CSV (labels=both) and returns raw
// CSV rows. key is the dotted dimension key ("1.AUS.Q" style; "all" allowed).
func (c *Client) FetchSDMXCSV(ctx context.Context, dataflow, key, startPeriod string) ([][]string, error) {
	url := fmt.Sprintf("%s/ABS,%s/%s?startPeriod=%s", absBase, dataflow, key, startPeriod)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept", csvAccept)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("ABS %s/%s: HTTP %d: %s", dataflow, key, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// ColIndex maps SDMX-CSV header names to column indexes. labels=both headers
// look like "REGION: Region" — the map key is the code part before the colon.
func ColIndex(header []string) map[string]int {
	idx := make(map[string]int, len(header))
	for i, h := range header {
		name := strings.TrimSpace(strings.SplitN(h, ":", 2)[0])
		idx[name] = i
	}
	return idx
}

// Code returns the code half of a "code: label" cell (or the cell verbatim).
func Code(cell string) string {
	return strings.TrimSpace(strings.SplitN(cell, ":", 2)[0])
}

// Label returns the label half of a "code: label" cell (or the cell verbatim).
func Label(cell string) string {
	parts := strings.SplitN(cell, ":", 2)
	if len(parts) == 2 {
		return strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(cell)
}

// Cell is bounds-safe row access.
func Cell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

// ApplyMult scales a value by the SDMX UNIT_MULT cell (10^mult).
func ApplyMult(val float64, multCell string) float64 {
	code := Code(multCell)
	if code == "" {
		return val
	}
	m, err := strconv.Atoi(code)
	if err != nil {
		return val
	}
	return val * math.Pow10(m)
}
```

- [ ] **Step 4: Implement `period.go`:**

```go
package absdata

import (
	"strconv"
	"strings"
	"time"
)

// PeriodDate parses an SDMX TIME_PERIOD ("2024", "2024-Q3", "2024-05") into
// the first day of the period plus a frequency label.
func PeriodDate(s string) (time.Time, string, bool) {
	s = strings.TrimSpace(s)
	switch {
	case len(s) == 4:
		y, err := strconv.Atoi(s)
		if err != nil {
			return time.Time{}, "", false
		}
		return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC), "annual", true
	case len(s) == 7 && strings.Contains(s, "-Q"):
		y, err := strconv.Atoi(s[:4])
		q, err2 := strconv.Atoi(s[6:])
		if err != nil || err2 != nil || q < 1 || q > 4 {
			return time.Time{}, "", false
		}
		return time.Date(y, time.Month((q-1)*3+1), 1, 0, 0, 0, 0, time.UTC), "quarterly", true
	case len(s) == 7 && s[4] == '-':
		y, err := strconv.Atoi(s[:4])
		m, err2 := strconv.Atoi(s[5:])
		if err != nil || err2 != nil || m < 1 || m > 12 {
			return time.Time{}, "", false
		}
		return time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.UTC), "monthly", true
	}
	return time.Time{}, "", false
}
```

- [ ] **Step 5: Implement `rba.go`** (adapted verbatim from `house-price-collector/rba.go`, exported):

```go
package absdata

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const rbaCSVBase = "https://www.rba.gov.au/statistics/tables/csv/"

// RBALicence is the licence string for RBA statistical tables.
const RBALicence = "CC-BY-4.0"

// FetchRBATable downloads one RBA statistical table CSV (e.g. "f1.1-data.csv").
func (c *Client) FetchRBATable(ctx context.Context, file string) ([][]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rbaCSVBase+file, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("RBA %s: HTTP %d: %s", file, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// FindRBASeries locates a series column by exact Series ID and returns the
// column index and the row index where data starts.
func FindRBASeries(rows [][]string, seriesID string) (col, dataStart int, ok bool) {
	for i, row := range rows {
		if len(row) == 0 || !strings.EqualFold(strings.TrimSpace(row[0]), "Series ID") {
			continue
		}
		for j, v := range row {
			if strings.TrimSpace(v) == seriesID {
				return j, i + 1, true
			}
		}
		return -1, -1, false
	}
	return -1, -1, false
}

// ParseRBADate accepts DD/MM/YYYY, DD-Mon-YYYY and Mon-YYYY (month-end).
func ParseRBADate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"02/01/2006", "02-Jan-2006"} {
		if d, err := time.Parse(layout, s); err == nil {
			return d.UTC(), true
		}
	}
	if d, err := time.Parse("Jan-2006", s); err == nil {
		return d.AddDate(0, 1, -1).UTC(), true
	}
	return time.Time{}, false
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd services && go test ./pkg/absdata/... -v`
Expected: PASS (all 6 tests).

- [ ] **Step 7: Commit**

```bash
git add services/pkg/absdata/
git commit -m "feat(absdata): shared ABS SDMX + RBA CSV clients"
```

---

## Task 3: economy-collector skeleton — series types, store, main

**Files:**
- Create: `services/economy-collector/series.go`
- Create: `services/economy-collector/store.go`
- Create: `services/economy-collector/main.go`
- Test: `services/economy-collector/series_test.go`

- [ ] **Step 1: Write failing test** for the series-key builder:

```go
package main

import "testing"

func TestBuildKey(t *testing.T) {
	cases := []struct {
		def  SeriesDef
		want string
	}{
		{SeriesDef{Topic: "rates", Metric: "cash_rate_target", RegionCode: "aus", Adjustment: "original"},
			"rates.cash_rate_target.aus"},
		{SeriesDef{Topic: "petroleum", Metric: "refinery_output", Product: "diesel", RegionCode: "aus", Adjustment: "original"},
			"petroleum.refinery_output.diesel.aus"},
		{SeriesDef{Topic: "labour", Metric: "unemployment_rate", Product: "total", RegionCode: "nsw", Adjustment: "seasadj"},
			"labour.unemployment_rate.total.nsw.seasadj"},
	}
	for _, c := range cases {
		if got := c.def.Key(); got != c.want {
			t.Fatalf("Key() = %q, want %q", got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/... -v`
Expected: FAIL (does not compile).

- [ ] **Step 3: Implement `series.go`:**

```go
package main

import (
	"strings"
	"time"
)

// SeriesDef is the catalog entry for one economic series. Key() derives the
// stable series_key: topic.metric[.product].region[.adjustment], adjustment
// segment only when not "original".
type SeriesDef struct {
	Topic      string
	Metric     string
	Product    string // optional
	RegionType string // national | state | refinery | industry
	RegionCode string // lowercase: aus | nsw | ...
	RegionName string
	Unit       string
	Frequency  string // monthly | quarterly | annual
	Adjustment string // original | seasadj | trend
	Dimensions map[string]string
	SourceKey  string
	Licence    string
}

func (d SeriesDef) Key() string {
	parts := []string{d.Topic, d.Metric}
	if d.Product != "" {
		parts = append(parts, d.Product)
	}
	parts = append(parts, d.RegionCode)
	if d.Adjustment != "" && d.Adjustment != "original" {
		parts = append(parts, d.Adjustment)
	}
	return strings.Join(parts, ".")
}

// Obs is one observation for a series.
type Obs struct {
	Series SeriesDef
	Period time.Time
	Value  float64
}

// slug lowercases and snake_cases a label for use in keys/products.
func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevUnderscore := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			prevUnderscore = false
		default:
			if !prevUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				prevUnderscore = true
			}
		}
	}
	return strings.TrimSuffix(b.String(), "_")
}
```

- [ ] **Step 4: Implement `store.go`** (connection idiom from `house-price-collector/store.go:33-42`; upserts write catalog first, then observations by series_key):

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func connect(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	// SimpleProtocol keeps the Supabase transaction pooler (port 6543) happy.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 4
	return pgxpool.NewWithConfig(ctx, cfg)
}

// upsertObservations writes catalog rows then observations for a batch of
// observations, all inside one transaction so a failing source never leaves
// half-written data (per-source atomicity).
func upsertObservations(ctx context.Context, pool *pgxpool.Pool, obs []Obs) (int, error) {
	if len(obs) == 0 {
		return 0, fmt.Errorf("importer produced 0 observations — treating as format drift, not success")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Upsert distinct series defs, collecting series_key -> id.
	ids := map[string]int64{}
	const sq = `
		INSERT INTO economic_series
			(series_key, topic, metric, product, region_type, region_code,
			 region_name, unit, frequency, adjustment, dimensions, source_key, licence)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (series_key) DO UPDATE SET
			region_name = EXCLUDED.region_name, unit = EXCLUDED.unit,
			dimensions = EXCLUDED.dimensions, updated_at = now()
		RETURNING id`
	for _, o := range obs {
		key := o.Series.Key()
		if _, done := ids[key]; done {
			continue
		}
		dims, err := json.Marshal(orEmpty(o.Series.Dimensions))
		if err != nil {
			return 0, err
		}
		var id int64
		if err := tx.QueryRow(ctx, sq,
			key, o.Series.Topic, o.Series.Metric, o.Series.Product,
			o.Series.RegionType, o.Series.RegionCode, o.Series.RegionName,
			o.Series.Unit, o.Series.Frequency, adjustmentOrDefault(o.Series.Adjustment),
			string(dims), o.Series.SourceKey, o.Series.Licence,
		).Scan(&id); err != nil {
			return 0, fmt.Errorf("upsert series %s: %w", key, err)
		}
		ids[key] = id
	}

	// 2. Batch-upsert observations (latest vintage wins).
	const oq = `
		INSERT INTO economic_observations (series_id, period, value)
		VALUES ($1, $2, $3)
		ON CONFLICT (series_id, period) DO UPDATE SET value = EXCLUDED.value`
	batch := &pgx.Batch{}
	for _, o := range obs {
		batch.Queue(oq, ids[o.Series.Key()], o.Period, o.Value)
	}
	br := tx.SendBatch(ctx, batch)
	n := 0
	for range obs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return n, err
		}
		n++
	}
	if err := br.Close(); err != nil {
		return n, err
	}
	return n, tx.Commit(ctx)
}

func adjustmentOrDefault(a string) string {
	if a == "" {
		return "original"
	}
	return a
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
```

- [ ] **Step 5: Implement `main.go`** (dispatch mirrors `house-price-collector/main.go:24-126`; importer functions land in Tasks 4-9 — stub them now so the package compiles, each returning a "not implemented" error, and replace per task):

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	os.Exit(run())
}

func run() int {
	mode := flag.String("mode", "all", "sources | rba | cpi | labour | trade | gdp | petroleum | all")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("ECONOMY_TIMEOUT_MIN", 20))*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	client := absdata.NewClient()

	type job struct {
		name string
		fn   func(context.Context, *absdata.Client) ([]Obs, error)
	}
	jobs := map[string]job{
		"rba":       {"rba-key-indicators", ingestRBA},
		"cpi":       {"abs-cpi", ingestCPI},
		"labour":    {"abs-labour-force", ingestLabour},
		"trade":     {"abs-merch-trade-state", ingestTradeByState},
		"gdp":       {"abs-state-accounts", ingestStateAccounts},
		"petroleum": {"dcceew-petroleum-statistics", ingestPetroleum},
	}

	runJob := func(j job) bool {
		obs, err := j.fn(ctx, client)
		if err != nil {
			log.Printf("ERROR %s: %v", j.name, err)
			return false
		}
		n, err := upsertObservations(ctx, pool, obs)
		if err != nil {
			log.Printf("ERROR %s upsert (wrote %d): %v", j.name, n, err)
			return false
		}
		log.Printf("ok %s: %d observations", j.name, n)
		return true
	}

	switch *mode {
	case "sources":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
	case "rba", "cpi", "labour", "trade", "gdp", "petroleum":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
		if !runJob(jobs[*mode]) {
			return 1
		}
	case "all":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
		failed := 0
		for _, name := range []string{"rba", "cpi", "labour", "trade", "gdp", "petroleum"} {
			if !runJob(jobs[name]) {
				failed++
			}
		}
		if failed > 0 {
			log.Printf("%d/6 sources failed", failed)
			return 1
		}
	default:
		log.Fatalf("unknown -mode %q (want sources|rba|cpi|labour|trade|gdp|petroleum|all)", *mode)
	}
	return 0
}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// Stubs replaced by Tasks 4-9. Each returns an error so `-mode all` fails
// loudly rather than silently skipping an unimplemented source.
var errNotImplemented = fmt.Errorf("importer not implemented yet")

func ingestCPI(ctx context.Context, c *absdata.Client) ([]Obs, error)          { return nil, errNotImplemented }
func ingestLabour(ctx context.Context, c *absdata.Client) ([]Obs, error)       { return nil, errNotImplemented }
func ingestTradeByState(ctx context.Context, c *absdata.Client) ([]Obs, error) { return nil, errNotImplemented }
func ingestStateAccounts(ctx context.Context, c *absdata.Client) ([]Obs, error) { return nil, errNotImplemented }
func ingestPetroleum(ctx context.Context, c *absdata.Client) ([]Obs, error)    { return nil, errNotImplemented }
func ingestRBA(ctx context.Context, c *absdata.Client) ([]Obs, error)          { return nil, errNotImplemented }
```

(As each importer task lands, DELETE its stub line from main.go.)

- [ ] **Step 6: Implement `registerSources` + source definitions.** First verify the registry table's column names:

Run: `grep -A30 "CREATE TABLE.*industry_intelligence_sources" services/migrations/000075_add_industry_intelligence_sources.up.sql`
Adjust the column list below to exactly match. Create `services/economy-collector/sources.go`:

```go
package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type sourceDef struct {
	Key, DisplayName, SignalKind, Publisher, URL, Licence, Cadence, Method, Notes string
}

var sourceDefs = []sourceDef{
	{"rba-key-indicators", "RBA key indicators (cash rate, exchange rates)", "economic_series",
		"Reserve Bank of Australia", "https://www.rba.gov.au/statistics/tables/",
		"CC-BY-4.0", "Monthly", "download", "Tables F1.1 + F11; national policy/FX series."},
	{"abs-cpi", "ABS Consumer Price Index", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "All-groups index + annual change via SDMX."},
	{"abs-labour-force", "ABS Labour Force, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Unemployment/participation by state, seasonally adjusted, via SDMX."},
	{"abs-merch-trade-state", "ABS International Merchandise Trade by state", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Export/import value by state of origin × SITC section via SDMX."},
	{"abs-state-accounts", "ABS Australian National Accounts: State Accounts", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-state-accounts/latest-release",
		"CC-BY-4.0", "Annual", "download", "GSP chain volume + growth by state via SDMX."},
	{"dcceew-petroleum-statistics", "Australian Petroleum Statistics", "economic_series",
		"Department of Climate Change, Energy, the Environment and Water", "https://www.energy.gov.au/publications/australian-petroleum-statistics",
		"CC-BY-4.0", "Monthly", "download", "Refinery output, fuel sales by state, petroleum imports/exports (XLSX)."},
}

// registerSources upserts this collector's sources into the shared registry.
// public_enabled must NEVER be downgraded by a re-run (existing OR excluded).
func registerSources(ctx context.Context, pool *pgxpool.Pool) error {
	const q = `
		INSERT INTO industry_intelligence_sources
			(source_key, display_name, signal_kind, publisher, source_url,
			 licence, cadence, collection_method, enabled, public_enabled,
			 exact_entity_required, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,TRUE,FALSE,$9)
		ON CONFLICT (source_key) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			publisher = EXCLUDED.publisher,
			source_url = EXCLUDED.source_url,
			licence = EXCLUDED.licence,
			cadence = EXCLUDED.cadence,
			notes = EXCLUDED.notes,
			public_enabled = industry_intelligence_sources.public_enabled OR EXCLUDED.public_enabled,
			updated_at = now()`
	for _, s := range sourceDefs {
		if _, err := pool.Exec(ctx, q, s.Key, s.DisplayName, s.SignalKind, s.Publisher,
			s.URL, s.Licence, s.Cadence, s.Method, s.Notes); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 7: Build + run tests**

Run: `cd services && go build -o /tmp/economy-collector ./economy-collector/ && echo BUILD_OK && go test ./economy-collector/... -v`
Expected: BUILD_OK printed; `TestBuildKey` PASS.

- [ ] **Step 8: Smoke against local DB** (registry only):

Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode sources && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT source_key FROM industry_intelligence_sources WHERE signal_kind='economic_series'"`
Expected: 6 rows.

- [ ] **Step 9: Commit**

```bash
git add services/economy-collector/
git commit -m "feat(economy-collector): skeleton — series model, store, mode dispatch, source registry"
```

---

## Task 4: RBA importer (`rates` topic)

**Files:**
- Create: `services/economy-collector/rba.go`
- Test: `services/economy-collector/rba_test.go`
- Modify: `services/economy-collector/main.go` (delete the `ingestRBA` stub line)

- [ ] **Step 1: Write failing test:**

```go
package main

import (
	"testing"
	"time"
)

func rbaFixture() [][]string {
	return [][]string{
		{"F1.1 INTEREST RATES AND YIELDS"},
		{"Series ID", "FIRMMCRT"},
		{"03/06/2026", "3.60"},
		{"04/06/2026", ""},
	}
}

func TestParseRBASeries(t *testing.T) {
	obs, err := parseRBASeries(rbaFixture(), "f1.1-data.csv", []rbaSpec{
		{seriesID: "FIRMMCRT", metric: "cash_rate_target", unit: "percent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs (blank cell skipped), got %d", len(obs))
	}
	o := obs[0]
	if o.Series.Key() != "rates.cash_rate_target.aus" || o.Value != 3.60 {
		t.Fatalf("unexpected obs: %+v", o)
	}
	if !o.Period.Equal(time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("period: %v", o.Period)
	}
	if _, err := parseRBASeries(rbaFixture(), "f1.1-data.csv", []rbaSpec{{seriesID: "MISSING", metric: "x", unit: "y"}}); err == nil {
		t.Fatal("want error for missing series")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParseRBASeries -v`
Expected: FAIL (parseRBASeries undefined).

- [ ] **Step 3: Implement `rba.go`** (and delete the `ingestRBA` stub from main.go):

```go
package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

type rbaSpec struct {
	seriesID string
	metric   string
	unit     string
}

// F1.1 = cash rate; F11 = exchange rates (AUD/USD FXRUSD, TWI FXRTWI).
var rbaTables = []struct {
	file  string
	freq  string
	specs []rbaSpec
}{
	{"f1.1-data.csv", "monthly", []rbaSpec{
		{seriesID: "FIRMMCRT", metric: "cash_rate_target", unit: "percent"},
	}},
	{"f11.1-data.csv", "monthly", []rbaSpec{
		{seriesID: "FXRUSD", metric: "aud_usd", unit: "usd"},
		{seriesID: "FXRTWI", metric: "trade_weighted_index", unit: "index"},
	}},
}

func ingestRBA(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	var all []Obs
	for _, t := range rbaTables {
		rows, err := c.FetchRBATable(ctx, t.file)
		if err != nil {
			return nil, err
		}
		obs, err := parseRBASeries(rows, t.file, t.specs)
		if err != nil {
			return nil, err
		}
		for i := range obs {
			obs[i].Series.Frequency = t.freq
		}
		all = append(all, obs...)
	}
	return all, nil
}

func parseRBASeries(rows [][]string, file string, specs []rbaSpec) ([]Obs, error) {
	var obs []Obs
	for _, s := range specs {
		col, dataStart, ok := absdata.FindRBASeries(rows, s.seriesID)
		if !ok {
			return nil, fmt.Errorf("RBA %s: series %s not found", file, s.seriesID)
		}
		def := SeriesDef{
			Topic: "rates", Metric: s.metric,
			RegionType: "national", RegionCode: "aus", RegionName: "Australia",
			Unit: s.unit, Frequency: "monthly", Adjustment: "original",
			SourceKey: "rba-key-indicators", Licence: absdata.RBALicence,
			Dimensions: map[string]string{"rba_series_id": s.seriesID, "rba_table": file},
		}
		for _, row := range rows[dataStart:] {
			if len(row) <= col {
				continue
			}
			period, ok := absdata.ParseRBADate(row[0])
			if !ok {
				continue
			}
			val, err := strconv.ParseFloat(strings.TrimSpace(row[col]), 64)
			if err != nil {
				continue // blank/withheld cell
			}
			obs = append(obs, Obs{Series: def, Period: period, Value: val})
		}
	}
	return obs, nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd services && go test ./economy-collector/ -run TestParseRBASeries -v`
Expected: PASS.

- [ ] **Step 5: Verify the F11 filename + series IDs against the live table** (filenames drift; f11.1-data.csv vs f11-data.csv):

Run: `curl -sS -A "shorted-data/1.0 (+https://shorted.com.au)" https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv | head -12`
Expected: a CSV with a `Series ID` row containing `FXRUSD`. If 404, try `f11-data.csv` and update `rbaTables` accordingly. Then live smoke:

Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode rba && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT series_key, count(*) FROM economic_series s JOIN economic_observations o ON o.series_id=s.id GROUP BY 1"`
Expected: 3 series (cash rate, AUD/USD, TWI) with hundreds of observations each.

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/rba.go services/economy-collector/rba_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): RBA cash rate + FX importer"
```

---

## Task 5: ABS CPI importer

**Files:**
- Create: `services/economy-collector/cpi.go`
- Test: `services/economy-collector/cpi_test.go`
- Modify: `services/economy-collector/main.go` (delete `ingestCPI` stub)

- [ ] **Step 1: Probe the CPI dataflow to pin dimension codes** (the ABS SDMX catalog is authoritative; do NOT trust guessed keys):

Run: `curl -sS -A "shorted-data/1.0 (+https://shorted.com.au)" -H "Accept: application/vnd.sdmx.data+csv;labels=both" "https://data.api.abs.gov.au/rest/data/ABS,CPI/all?startPeriod=2025-Q3&lastNObservations=1" | head -5`
Record from the header + a sample row: the exact column names (expect `MEASURE`, `INDEX`, `TSEST`, `REGION`, `TIME_PERIOD`, `OBS_VALUE`, `UNIT_MULT`) and the codes for: All groups CPI index (`INDEX=10001`), original series, weighted average of eight capital cities (`REGION=50`), plus per-capital-city region codes. Update the constants in Step 4 if they differ.

- [ ] **Step 2: Write failing test** (fixture header mirrors what the probe returned; adjust cell columns to match your constants):

```go
package main

import "testing"

func cpiFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "INDEX: Index", "TSEST: Adjustment", "REGION: Region", "TIME_PERIOD: Time", "OBS_VALUE", "UNIT_MULT: Unit"},
		{"ABS:CPI(1.0.0)", "1: Index Numbers", "10001: All groups CPI", "10: Original", "50: Weighted average of eight capital cities", "2026-Q1", "141.2", "0: Units"},
		{"ABS:CPI(1.0.0)", "3: Percentage Change from Corresponding Quarter of Previous Year", "10001: All groups CPI", "10: Original", "50: Weighted average of eight capital cities", "2026-Q1", "2.4", "0: Units"},
		{"ABS:CPI(1.0.0)", "1: Index Numbers", "999999: Something else", "10: Original", "50: Weighted average of eight capital cities", "2026-Q1", "999", "0: Units"},
	}
}

func TestParseCPI(t *testing.T) {
	obs, err := parseCPI(cpiFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (non-all-groups filtered), got %d", len(obs))
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["cpi.index.all_groups.aus"] != 141.2 {
		t.Fatalf("index obs missing/wrong: %#v", byKey)
	}
	if byKey["cpi.annual_change.all_groups.aus"] != 2.4 {
		t.Fatalf("annual change obs missing/wrong: %#v", byKey)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParseCPI -v`
Expected: FAIL.

- [ ] **Step 4: Implement `cpi.go`** (delete `ingestCPI` stub from main.go). Constants at top get the values recorded in Step 1:

```go
package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from the SDMX probe (Task 5 Step 1). If a probe shows different
// codes after an ABS dataflow version bump, update here — parse is name-based
// and survives column reorder.
const (
	cpiFlow          = "CPI"
	cpiIndexAllGroups = "10001" // All groups CPI
	cpiMeasureIndex   = "1"     // Index numbers
	cpiMeasureAnnual  = "3"     // % change from corresponding quarter, previous year
	cpiRegionWeighted = "50"    // Weighted average of eight capital cities
	cpiStartPeriod    = "2000-Q1"
)

func ingestCPI(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, cpiFlow, "all", cpiStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseCPI(rows)
}

func parseCPI(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	var obs []Obs
	for _, row := range rows[1:] {
		if absdata.Code(absdata.Cell(row, idx["INDEX"])) != cpiIndexAllGroups {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["REGION"])) != cpiRegionWeighted {
			continue
		}
		measure := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		var metric, unit string
		switch measure {
		case cpiMeasureIndex:
			metric, unit = "index", "index"
		case cpiMeasureAnnual:
			metric, unit = "annual_change", "percent"
		default:
			continue
		}
		period, freq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "cpi", Metric: metric, Product: "all_groups",
				RegionType: "national", RegionCode: "aus", RegionName: "Australia",
				Unit: unit, Frequency: freq, Adjustment: "original",
				SourceKey: "abs-cpi", Licence: absdata.Licence,
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}
```

- [ ] **Step 5: Run tests, then live smoke**

Run: `cd services && go test ./economy-collector/ -run TestParseCPI -v`
Expected: PASS.
Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode cpi && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT series_key, count(*), max(period) FROM economic_series s JOIN economic_observations o ON o.series_id=s.id WHERE topic='cpi' GROUP BY 1"`
Expected: `cpi.index.all_groups.aus` and `cpi.annual_change.all_groups.aus`, ~100 quarters each, max period within the last two quarters. If the fetch 404s or the filter yields 0 rows, re-run the Step 1 probe and fix the constants.

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/cpi.go services/economy-collector/cpi_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): ABS CPI importer"
```

---

## Task 6: ABS Labour Force importer

**Files:**
- Create: `services/economy-collector/labour.go`
- Test: `services/economy-collector/labour_test.go`
- Modify: `services/economy-collector/main.go` (delete `ingestLabour` stub)

- [ ] **Step 1: Probe the LF dataflow:**

Run: `curl -sS -A "shorted-data/1.0 (+https://shorted.com.au)" -H "Accept: application/vnd.sdmx.data+csv;labels=both" "https://data.api.abs.gov.au/rest/data/ABS,LF/all?startPeriod=2026-05&lastNObservations=1" | head -5`
Record: column names (expect `MEASURE`, `SEX`, `AGE`, `TSEST`, `STATE`/`REGION`, `TIME_PERIOD`, `OBS_VALUE`) and codes for: unemployment rate, participation rate, employed persons; persons (both sexes); all ages; seasonally adjusted; the state codes (ABS uses 1=NSW, 2=VIC, 3=QLD, 4=SA, 5=WA, 6=TAS, 7=NT, 8=ACT, AUS for national — confirm). Update constants below to match.

- [ ] **Step 2: Write failing test:**

```go
package main

import "testing"

func lfFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "SEX: Sex", "AGE: Age", "TSEST: Adjustment", "STATE: State", "TIME_PERIOD: Time", "OBS_VALUE", "UNIT_MULT: Unit"},
		{"ABS:LF(1.0.0)", "14: Unemployment rate", "3: Persons", "1599: 15 years and over", "20: Seasonally Adjusted", "1: New South Wales", "2026-05", "4.1", "0: Units"},
		{"ABS:LF(1.0.0)", "5: Employed total", "3: Persons", "1599: 15 years and over", "20: Seasonally Adjusted", "AUS: Australia", "2026-05", "14322.5", "3: Thousands"},
		{"ABS:LF(1.0.0)", "14: Unemployment rate", "1: Males", "1599: 15 years and over", "20: Seasonally Adjusted", "1: New South Wales", "2026-05", "4.4", "0: Units"},
	}
}

func TestParseLabour(t *testing.T) {
	obs, err := parseLabour(lfFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (males row filtered), got %d", len(obs))
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["labour.unemployment_rate.total.nsw.seasadj"] != 4.1 {
		t.Fatalf("nsw unemployment missing: %#v", byKey)
	}
	// employed persons scaled by UNIT_MULT 10^3
	if byKey["labour.employed_persons.total.aus.seasadj"] != 14322500 {
		t.Fatalf("employed persons wrong: %#v", byKey)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParseLabour -v`
Expected: FAIL.

- [ ] **Step 4: Implement `labour.go`** (delete the stub from main.go):

```go
package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from the SDMX probe (Task 6 Step 1).
const (
	lfFlow        = "LF"
	lfSexPersons  = "3"
	lfAgeAll      = "1599"
	lfTsestSeasAdj = "20"
	lfStartPeriod = "2000-01"
)

// lfMeasures maps ABS MEASURE codes to (metric, unit).
var lfMeasures = map[string][2]string{
	"14": {"unemployment_rate", "percent"},
	"15": {"participation_rate", "percent"},
	"5":  {"employed_persons", "persons"},
}

// lfStates maps ABS state dimension codes to (region_code, region_name, region_type).
var lfStates = map[string][3]string{
	"AUS": {"aus", "Australia", "national"},
	"1":   {"nsw", "New South Wales", "state"},
	"2":   {"vic", "Victoria", "state"},
	"3":   {"qld", "Queensland", "state"},
	"4":   {"sa", "South Australia", "state"},
	"5":   {"wa", "Western Australia", "state"},
	"6":   {"tas", "Tasmania", "state"},
	"7":   {"nt", "Northern Territory", "state"},
	"8":   {"act", "Australian Capital Territory", "state"},
}

func ingestLabour(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, lfFlow, "all", lfStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseLabour(rows)
}

func parseLabour(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	var obs []Obs
	for _, row := range rows[1:] {
		m, ok := lfMeasures[absdata.Code(absdata.Cell(row, idx["MEASURE"]))]
		if !ok {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["SEX"])) != lfSexPersons {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["AGE"])) != lfAgeAll {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["TSEST"])) != lfTsestSeasAdj {
			continue
		}
		st, ok := lfStates[absdata.Code(absdata.Cell(row, idx["STATE"]))]
		if !ok {
			continue
		}
		period, freq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "labour", Metric: m[0], Product: "total",
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: m[1], Frequency: freq, Adjustment: "seasadj",
				SourceKey: "abs-labour-force", Licence: absdata.Licence,
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}
```

- [ ] **Step 5: Run tests, then live smoke**

Run: `cd services && go test ./economy-collector/ -run TestParseLabour -v`
Expected: PASS.
Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode labour && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT count(DISTINCT series_key) FROM economic_series WHERE topic='labour'"`
Expected: 27 series (3 metrics × 9 regions). NOTE: `LF/all` may be a very large pull — if the request times out, constrain the key using the probe's dimension order (e.g. `M.{measures}.3.1599.20.{states}` style partial key) instead of `all`, and record the final key in a code comment.

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/labour.go services/economy-collector/labour_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): ABS labour force by state importer"
```

---

## Task 7: ABS merchandise trade by state importer

**Files:**
- Create: `services/economy-collector/trade.go`
- Test: `services/economy-collector/trade_test.go`
- Modify: `services/economy-collector/main.go` (delete `ingestTradeByState` stub)

The influence-collector already pulls `MERCH_EXP`/`MERCH_IMP` at industry level (`services/influence-collector/trade.go` — read it first; its dataflow constants and dimension handling are the working reference). This importer pulls the same flows but keyed by **state of origin × SITC section**, national totals included.

- [ ] **Step 1: Probe both flows** for dimension names/codes:

Run: `curl -sS -A "shorted-data/1.0 (+https://shorted.com.au)" -H "Accept: application/vnd.sdmx.data+csv;labels=both" "https://data.api.abs.gov.au/rest/data/ABS,MERCH_EXP/all?startPeriod=2026-05&lastNObservations=1" | head -5`
Record: the commodity dimension (expect `COMMODITY_SITC`), state dimension (expect `STATE_ORIGIN` for exports / `STATE_DEST` for imports), country dimension code for "Total" (all countries), and SITC section codes `0`-`9` + `TOT`. Also check `services/influence-collector/trade.go` lines defining `absMerchExportFlow`/`absMerchImportFlow` for the exact registered flow names.

- [ ] **Step 2: Write failing test:**

```go
package main

import "testing"

func tradeFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity", "COUNTRY_DEST: Country", "STATE_ORIGIN: State", "TIME_PERIOD: Time", "OBS_VALUE", "UNIT_MULT: Unit"},
		{"ABS:MERCH_EXP(1.0.0)", "2: Crude materials, inedible, except fuels", "TOT: Total", "5: Western Australia", "2026-05", "18000", "6: Millions"},
		{"ABS:MERCH_EXP(1.0.0)", "2: Crude materials, inedible, except fuels", "036: Japan", "5: Western Australia", "2026-05", "4000", "6: Millions"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "AUS: Australia", "2026-05", "45000", "6: Millions"},
	}
}

func TestParseTrade(t *testing.T) {
	obs, err := parseTrade(tradeFixture(), "export_value", "STATE_ORIGIN")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (per-country row filtered), got %d", len(obs))
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["trade.export_value.crude_materials_inedible_except_fuels.wa"] != 1.8e10 {
		t.Fatalf("WA crude materials wrong: %#v", byKey)
	}
	if byKey["trade.export_value.total.aus"] != 4.5e10 {
		t.Fatalf("national total wrong: %#v", byKey)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParseTrade -v`
Expected: FAIL.

- [ ] **Step 4: Implement `trade.go`** (delete stub). The product slug comes from `slug(label)` of the SITC section; the country dimension is filtered to Total so we never double count:

```go
package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Flow + dimension names pinned from the probe (Task 7 Step 1) and cross-checked
// against services/influence-collector/trade.go.
const (
	tradeExportFlow  = "MERCH_EXP"
	tradeImportFlow  = "MERCH_IMP"
	tradeStartPeriod = "2015-01"
	tradeTotalCode   = "TOT"
)

// tradeStates reuses the same ABS state coding as labour (lfStates), plus AUS.

func ingestTradeByState(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	var all []Obs
	pulls := []struct {
		flow, metric, stateDim string
	}{
		{tradeExportFlow, "export_value", "STATE_ORIGIN"},
		{tradeImportFlow, "import_value", "STATE_DEST"},
	}
	for _, p := range pulls {
		rows, err := c.FetchSDMXCSV(ctx, p.flow, "all", tradeStartPeriod)
		if err != nil {
			return nil, err
		}
		obs, err := parseTrade(rows, p.metric, p.stateDim)
		if err != nil {
			return nil, err
		}
		all = append(all, obs...)
	}
	return all, nil
}

func parseTrade(rows [][]string, metric, stateDim string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	countryCol, hasCountry := countryColumn(idx)
	var obs []Obs
	for _, row := range rows[1:] {
		// Only country=Total rows — per-country splits would double count.
		if hasCountry && absdata.Code(absdata.Cell(row, countryCol)) != tradeTotalCode {
			continue
		}
		stateCell := absdata.Cell(row, idx[stateDim])
		st, ok := lfStates[absdata.Code(stateCell)]
		if !ok {
			continue
		}
		commodity := absdata.Cell(row, idx["COMMODITY_SITC"])
		product := slug(absdata.Label(commodity))
		if absdata.Code(commodity) == tradeTotalCode {
			product = "total"
		}
		period, freq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "trade", Metric: metric, Product: product,
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: "aud", Frequency: freq, Adjustment: "original",
				SourceKey: "abs-merch-trade-state", Licence: absdata.Licence,
				Dimensions: map[string]string{"sitc_code": absdata.Code(commodity)},
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}

// countryColumn finds whichever country dimension the flow carries.
func countryColumn(idx map[string]int) (int, bool) {
	for _, name := range []string{"COUNTRY_DEST", "COUNTRY_ORIGIN", "COUNTRY"} {
		if i, ok := idx[name]; ok {
			return i, true
		}
	}
	return -1, false
}
```

- [ ] **Step 5: Run tests, then live smoke** (this pull can be large — if `all` times out, key it to SITC sections `0..9+TOT` × country TOT using the probe's dimension order and note the key in a comment):

Run: `cd services && go test ./economy-collector/ -run TestParseTrade -v`
Expected: PASS.
Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode trade && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT metric, count(DISTINCT series_key) FROM economic_series WHERE topic='trade' GROUP BY 1"`
Expected: export_value + import_value, each with up to ~99 series (11 SITC groups × 9 regions).

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/trade.go services/economy-collector/trade_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): ABS merchandise trade by state importer"
```

---

## Task 8: ABS state accounts (GSP) importer

**Files:**
- Create: `services/economy-collector/gdp.go`
- Test: `services/economy-collector/gdp_test.go`
- Modify: `services/economy-collector/main.go` (delete `ingestStateAccounts` stub)

- [ ] **Step 1: Find + probe the state accounts dataflow:**

Run: `curl -sS -A "shorted-data/1.0 (+https://shorted.com.au)" "https://data.api.abs.gov.au/rest/dataflow/ABS?detail=allstubs" | grep -i -E "state account|ANA_" | head`
Then probe the matched flow (likely `ANA_AGG` or similar) with `lastNObservations=1` as in prior tasks. Record: the measure code for "Gross state product: Chain volume measures" (levels) and the % change measure if present, region/state dimension codes, TIME_PERIOD format (annual `2024-25` fiscal labels are possible — if the probe shows `2023-24` style, extend `absdata.PeriodDate` in a follow-up commit to map `2023-24` → 2023-07-01/annual, with a test).

- [ ] **Step 2: Write failing test:**

```go
package main

import "testing"

func gspFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "REGION: Region", "TIME_PERIOD: Time", "OBS_VALUE", "UNIT_MULT: Unit"},
		{"ABS:ANA_AGG(1.0.0)", "GSP_CVM: Gross state product, chain volume", "1: New South Wales", "2025", "720000", "6: Millions"},
		{"ABS:ANA_AGG(1.0.0)", "OTHER: Something else", "1: New South Wales", "2025", "1", "0: Units"},
	}
}

func TestParseStateAccounts(t *testing.T) {
	obs, err := parseStateAccounts(gspFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs, got %d", len(obs))
	}
	if obs[0].Series.Key() != "gdp.gsp_chain_volume.total.nsw" || obs[0].Value != 7.2e11 {
		t.Fatalf("unexpected: key=%s value=%v", obs[0].Series.Key(), obs[0].Value)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParseStateAccounts -v`
Expected: FAIL.

- [ ] **Step 4: Implement `gdp.go`** (delete stub; set the two constants from the probe):

```go
package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Pinned from the SDMX probe (Task 8 Step 1).
const (
	gspFlow        = "ANA_AGG"
	gspMeasureCVM  = "GSP_CVM"
	gspStartPeriod = "2000"
)

func ingestStateAccounts(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, gspFlow, "all", gspStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseStateAccounts(rows)
}

func parseStateAccounts(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	var obs []Obs
	for _, row := range rows[1:] {
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != gspMeasureCVM {
			continue
		}
		st, ok := lfStates[absdata.Code(absdata.Cell(row, idx["REGION"]))]
		if !ok {
			continue
		}
		period, freq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "gdp", Metric: "gsp_chain_volume", Product: "total",
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: "aud", Frequency: freq, Adjustment: "original",
				SourceKey: "abs-state-accounts", Licence: absdata.Licence,
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}
```

- [ ] **Step 5: Run tests + live smoke**

Run: `cd services && go test ./economy-collector/ -run TestParseStateAccounts -v` → PASS.
Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode gdp && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT count(DISTINCT series_key) FROM economic_series WHERE topic='gdp'"`
Expected: up to 9 series (8 states + AUS if the flow carries a national aggregate).

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/gdp.go services/economy-collector/gdp_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): ABS state accounts (GSP) importer"
```

---

## Task 9: DCCEEW petroleum statistics importer (XLSX)

**Files:**
- Create: `services/economy-collector/petroleum.go`
- Test: `services/economy-collector/petroleum_test.go`
- Modify: `services/economy-collector/main.go` (delete `ingestPetroleum` stub)
- Modify: `services/go.mod` (excelize is already a dependency via influence-collector's AusTender parser — verify with `grep excelize services/go.mod`)

Known landmines (spec §Petroleum): issue-numbered URLs (discover, don't hardcode); excelize date-styled cells render `mm-dd-yy`; header names drift between issues (fuzzy match, fail loudly).

- [ ] **Step 1: Manually inspect the current publication ONCE** to pin the sheet contract:

Run: `curl -sSL -A "shorted-data/1.0 (+https://shorted.com.au)" "https://www.energy.gov.au/publications/australian-petroleum-statistics" | grep -o 'href="[^"]*\.xlsx[^"]*"' | head`
Download the latest issue XLSX to /tmp and open it (or `python3 -c "import openpyxl; wb=openpyxl.load_workbook('/tmp/aps.xlsx'); print(wb.sheetnames)"`). Record the actual sheet names for: refinery output by product, sales/consumption of petroleum products by state, imports/exports by product. Fill the `petroleumSheets` config below with the REAL names + column labels observed. If the download page is JS-rendered or WAF-blocked, fall back to the data.gov.au CKAN mirror: `curl -sS "https://data.gov.au/api/3/action/package_search?q=australian+petroleum+statistics" | head -c 2000` and use the CKAN resource URL instead (record which path worked in a code comment).

- [ ] **Step 2: Write failing test** — build a synthetic XLSX in-memory with excelize so the test encodes the sheet contract without a binary fixture:

```go
package main

import (
	"testing"

	"github.com/xuri/excelize/v2"
)

func petroleumFixture(t *testing.T) *excelize.File {
	t.Helper()
	f := excelize.NewFile()
	sheet := "Table 3A"
	_, _ = f.NewSheet(sheet)
	rows := [][]interface{}{
		{"Refinery production of major products, megalitres"},
		{"Month", "Automotive gasoline", "Diesel oil", "Jet fuel"},
		{"May-2026", 380.5, 900.2, 210.0},
		{"Jun-2026", 390.1, 910.7, ""},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func TestParsePetroleumSheet(t *testing.T) {
	f := petroleumFixture(t)
	obs, err := parsePetroleumSheet(f, petroleumSheetSpec{
		SheetMatch:  "Table 3A",
		Metric:      "refinery_output",
		Unit:        "megalitres",
		RegionCode:  "aus",
		RegionName:  "Australia",
		HeaderMatch: "Month",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 5 {
		t.Fatalf("want 5 obs (blank cell skipped), got %d", len(obs))
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["petroleum.refinery_output.diesel_oil.aus"] != 910.7 {
		t.Fatalf("diesel latest wrong: %#v", byKey)
	}
}

func TestParsePetroleumSheetUnknownLayout(t *testing.T) {
	f := excelize.NewFile()
	_, err := parsePetroleumSheet(f, petroleumSheetSpec{SheetMatch: "Table 3A", HeaderMatch: "Month"})
	if err == nil {
		t.Fatal("want loud failure on missing sheet")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services && go test ./economy-collector/ -run TestParsePetroleum -v`
Expected: FAIL.

- [ ] **Step 4: Implement `petroleum.go`** (delete stub). Discovery + generic wide-sheet parser (months down column A, one product per column):

```go
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/xuri/excelize/v2"
)

const petroleumPage = "https://www.energy.gov.au/publications/australian-petroleum-statistics"

// petroleumSheetSpec describes one wide sheet: months in the first column,
// one product per subsequent column. Sheet + header located by substring
// match so issue-to-issue renames ("Table 3A" -> "Table 3a") don't break us.
type petroleumSheetSpec struct {
	SheetMatch  string
	Metric      string
	Unit        string
	RegionCode  string
	RegionName  string
	HeaderMatch string // cell text of the first header column (e.g. "Month")
}

// Pin these to the REAL sheet names observed in Task 9 Step 1.
var petroleumSheets = []petroleumSheetSpec{
	{SheetMatch: "Table 3A", Metric: "refinery_output", Unit: "megalitres", RegionCode: "aus", RegionName: "Australia", HeaderMatch: "Month"},
	{SheetMatch: "Table 2A", Metric: "refinery_input", Unit: "megalitres", RegionCode: "aus", RegionName: "Australia", HeaderMatch: "Month"},
	{SheetMatch: "Table 7", Metric: "imports", Unit: "megalitres", RegionCode: "aus", RegionName: "Australia", HeaderMatch: "Month"},
	{SheetMatch: "Table 8", Metric: "exports", Unit: "megalitres", RegionCode: "aus", RegionName: "Australia", HeaderMatch: "Month"},
	// Consumption (sales) by state sheets are per-state columns of ONE product
	// group per sheet in some issues — after Step 1 inspection, either add a
	// spec per sheet here or add a second parser variant if the layout differs.
}

func ingestPetroleum(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	xlsxURL, err := discoverPetroleumXLSX(ctx)
	if err != nil {
		return nil, err
	}
	f, err := fetchXLSX(ctx, xlsxURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var all []Obs
	for _, spec := range petroleumSheets {
		obs, err := parsePetroleumSheet(f, spec)
		if err != nil {
			return nil, fmt.Errorf("sheet %q: %w", spec.SheetMatch, err)
		}
		all = append(all, obs...)
	}
	return all, nil
}

var xlsxLinkRe = regexp.MustCompile(`href="([^"]+\.xlsx[^"]*)"`)

func discoverPetroleumXLSX(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, petroleumPage, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", absdata.UserAgent)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("petroleum page: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	m := xlsxLinkRe.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("no .xlsx link found on %s — layout changed", petroleumPage)
	}
	link := string(m[1])
	if strings.HasPrefix(link, "/") {
		link = "https://www.energy.gov.au" + link
	}
	return link, nil
}

func fetchXLSX(ctx context.Context, url string) (*excelize.File, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", absdata.UserAgent)
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("xlsx %s: HTTP %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	return excelize.OpenReader(bytes.NewReader(data))
}

func parsePetroleumSheet(f *excelize.File, spec petroleumSheetSpec) ([]Obs, error) {
	sheet := findSheet(f, spec.SheetMatch)
	if sheet == "" {
		return nil, fmt.Errorf("no sheet matching %q (have %v)", spec.SheetMatch, f.GetSheetList())
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}
	// Locate header row by its first-column label.
	headerIdx := -1
	for i, row := range rows {
		if len(row) > 0 && strings.EqualFold(strings.TrimSpace(row[0]), spec.HeaderMatch) {
			headerIdx = i
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("header row %q not found — layout drift", spec.HeaderMatch)
	}
	header := rows[headerIdx]
	var obs []Obs
	for _, row := range rows[headerIdx+1:] {
		if len(row) == 0 {
			continue
		}
		period, ok := parsePetroleumMonth(strings.TrimSpace(row[0]))
		if !ok {
			continue // footnote / blank tail rows
		}
		for col := 1; col < len(row) && col < len(header); col++ {
			product := slug(header[col])
			if product == "" {
				continue
			}
			val, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(row[col]), ",", ""), 64)
			if err != nil {
				continue
			}
			obs = append(obs, Obs{
				Series: SeriesDef{
					Topic: "petroleum", Metric: spec.Metric, Product: product,
					RegionType: regionTypeFor(spec.RegionCode), RegionCode: spec.RegionCode,
					RegionName: spec.RegionName, Unit: spec.Unit, Frequency: "monthly",
					Adjustment: "original",
					SourceKey:  "dcceew-petroleum-statistics", Licence: "CC-BY-4.0",
				},
				Period: period,
				Value:  val,
			})
		}
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("0 observations parsed — layout drift")
	}
	return obs, nil
}

func findSheet(f *excelize.File, match string) string {
	for _, s := range f.GetSheetList() {
		if strings.Contains(strings.ToLower(s), strings.ToLower(match)) {
			return s
		}
	}
	return ""
}

func regionTypeFor(code string) string {
	if code == "aus" {
		return "national"
	}
	return "state"
}

// parsePetroleumMonth handles the layouts excelize emits for date-styled
// cells: "May-2026", "May-26", "05-26" (mm-yy), "05-01-26" (mm-dd-yy).
func parsePetroleumMonth(s string) (time.Time, bool) {
	for _, layout := range []string{"Jan-2006", "Jan-06", "01-06", "01-02-06", "2006-01"} {
		if d, err := time.Parse(layout, s); err == nil {
			return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.UTC), true
		}
	}
	return time.Time{}, false
}
```

- [ ] **Step 5: Run tests, then live smoke**

Run: `cd services && go test ./economy-collector/ -run TestParsePetroleum -v`
Expected: PASS (both tests).
Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode petroleum && psql postgresql://admin:password@localhost:5438/shorts -c "SELECT metric, count(DISTINCT series_key) FROM economic_series WHERE topic='petroleum' GROUP BY 1"`
Expected: refinery_output/refinery_input/imports/exports series present. Iterate `petroleumSheets` specs against the real workbook until the four target tables ingest (this is the expected tuning loop for this source — the test protects the parser mechanics, Step 1's inspection pins the sheet names).

- [ ] **Step 6: Full-collector run + commit**

Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./economy-collector -mode all; echo "exit=$?"`
Expected: `exit=0`, six "ok" lines.

```bash
git add services/economy-collector/petroleum.go services/economy-collector/petroleum_test.go services/economy-collector/main.go
git commit -m "feat(economy-collector): DCCEEW petroleum statistics XLSX importer"
```

---

## Task 10: Proto — ListEconomicSeries + GetEconomicSeries

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`
- Generated (committed): `services/gen/proto/go/...`, `web/src/gen/...`

- [ ] **Step 1: Add RPCs inside `service ShortedStocksService`** (after the housing RPCs, ~line 639):

```proto
  // List economic series catalog entries (Australian economy snapshot layer).
  rpc ListEconomicSeries (ListEconomicSeriesRequest) returns (ListEconomicSeriesResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
    option (gnostic.openapi.v3.operation) = {
      summary: "List Economic Series",
      description: "Catalog of Australian economic series (petroleum, trade by state, GDP, labour, CPI, policy rates) with dimensions, units and source attribution. Sourced from ABS, RBA and DCCEEW open data."
    };
  }

  // Fetch observations for up to 50 series by series_key.
  rpc GetEconomicSeries (GetEconomicSeriesRequest) returns (GetEconomicSeriesResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
    option (gnostic.openapi.v3.operation) = {
      summary: "Get Economic Series",
      description: "Time-series observations for named economic series keys (e.g. petroleum.refinery_output.diesel.aus, trade.export_value.total.wa), with unit, frequency and licence."
    };
  }
```

- [ ] **Step 2: Add messages** (new section after the housing messages, ~line 2106):

```proto
// ── Economy (Australian economy snapshot) ────────────────────────────────────

message EconomicSeriesInfo {
  string series_key = 1;    // 'topic.metric[.product].region[.adjustment]'
  string topic = 2;         // 'petroleum' | 'trade' | 'gdp' | 'labour' | 'cpi' | 'rates'
  string metric = 3;
  string product = 4;       // '' when not applicable
  string region_type = 5;   // 'national' | 'state' | 'refinery' | 'industry'
  string region_code = 6;   // 'aus' | 'nsw' | ...
  string region_name = 7;
  string unit = 8;          // 'aud' | 'percent' | 'index' | 'megalitres' | ...
  string frequency = 9;     // 'monthly' | 'quarterly' | 'annual'
  string adjustment = 10;   // 'original' | 'seasadj' | 'trend'
  string source_key = 11;
  string source_licence = 12;
  google.protobuf.Timestamp latest_period = 13;
}

message ListEconomicSeriesRequest {
  string topic = 1;        // optional filters; empty = all
  string metric = 2;
  string region_type = 3;
  string region_code = 4;
  string product = 5;
  int32 limit = 6;         // default 200, max 500
}

message ListEconomicSeriesResponse {
  repeated EconomicSeriesInfo series = 1;
}

message EconomicObservation {
  google.protobuf.Timestamp period = 1;
  double value = 2;
}

message EconomicSeriesData {
  EconomicSeriesInfo info = 1;
  repeated EconomicObservation observations = 2; // capped at 600, oldest first
}

message GetEconomicSeriesRequest {
  repeated string series_keys = 1;            // max 50
  google.protobuf.Timestamp start_period = 2; // optional
}

message GetEconomicSeriesResponse {
  repeated EconomicSeriesData series = 1;
}
```

- [ ] **Step 3: Generate + verify**

Run: `cd proto && buf generate && cd .. && grep -l "ListEconomicSeries" services/gen/proto/go -r | head -3 && grep -l "ListEconomicSeries" web/src/gen -r | head -3`
Expected: generated Go + TS files reference the new RPCs.

- [ ] **Step 4: Commit**

```bash
git add proto/shortedapi/shorts/v1alpha1/shorts.proto services/gen web/src/gen
git commit -m "feat(proto): ListEconomicSeries + GetEconomicSeries public RPCs"
```

---

## Task 11: Store layer — postgres queries + interface plumbing

**Files:**
- Create: `services/shorts/internal/store/shorts/postgres_economy.go`
- Modify: `services/shorts/internal/store/shorts/store.go` (Store interface)
- Modify: `services/shorts/internal/services/shorts/interfaces.go` (service Store + Cache interfaces)
- Modify: `services/shorts/internal/services/shorts/adapters.go` (StoreAdapter pass-throughs)
- Modify: `services/shorts/internal/services/shorts/cache.go` (key generators)
- Regenerate: `services/shorts/internal/services/shorts/mocks/mock_interfaces.go`
- Test: `services/shorts/internal/store/shorts/postgres_economy_test.go` (only if a pure helper needs one; the query methods are covered by the handler tests in Task 12 via mocks + the integration smoke)

- [ ] **Step 1: Implement `postgres_economy.go`:**

```go
package shorts

import (
	"context"
	"time"
)

// EconomicSeriesRow is one catalog entry (+ latest period for the list view).
type EconomicSeriesRow struct {
	SeriesKey     string
	Topic         string
	Metric        string
	Product       string
	RegionType    string
	RegionCode    string
	RegionName    string
	Unit          string
	Frequency     string
	Adjustment    string
	SourceKey     string
	SourceLicence string
	LatestPeriod  time.Time
}

// EconomicObservationRow is one (period, value) pair.
type EconomicObservationRow struct {
	Period time.Time
	Value  float64
}

// EconomicSeriesDataRow is a catalog entry plus its observations.
type EconomicSeriesDataRow struct {
	Info   EconomicSeriesRow
	Points []EconomicObservationRow
}

// ListEconomicSeries returns catalog entries matching the optional filters.
func (s *postgresStore) ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*EconomicSeriesRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 500 {
		limit = 200
	}

	const query = `
		SELECT es.series_key, es.topic, es.metric, COALESCE(es.product, ''),
		       es.region_type, es.region_code, es.region_name, es.unit,
		       es.frequency, es.adjustment, es.source_key, es.licence,
		       COALESCE(lp.latest, '0001-01-01'::date)
		FROM economic_series es
		LEFT JOIN LATERAL (
			SELECT max(period) AS latest FROM economic_observations o WHERE o.series_id = es.id
		) lp ON TRUE
		WHERE ($1 = '' OR es.topic = $1)
		  AND ($2 = '' OR es.metric = $2)
		  AND ($3 = '' OR es.region_type = $3)
		  AND ($4 = '' OR es.region_code = $4)
		  AND ($5 = '' OR es.product = $5)
		ORDER BY es.series_key
		LIMIT $6`

	rows, err := s.db.Query(ctx, query, topic, metric, regionType, regionCode, product, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*EconomicSeriesRow
	for rows.Next() {
		var r EconomicSeriesRow
		if err := rows.Scan(&r.SeriesKey, &r.Topic, &r.Metric, &r.Product,
			&r.RegionType, &r.RegionCode, &r.RegionName, &r.Unit,
			&r.Frequency, &r.Adjustment, &r.SourceKey, &r.SourceLicence,
			&r.LatestPeriod); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// GetEconomicSeries returns observations (oldest first, capped at 600/series)
// for the requested keys. Unknown keys are silently absent from the result.
func (s *postgresStore) GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*EconomicSeriesDataRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if len(seriesKeys) > 50 {
		seriesKeys = seriesKeys[:50]
	}

	const query = `
		SELECT es.series_key, es.topic, es.metric, COALESCE(es.product, ''),
		       es.region_type, es.region_code, es.region_name, es.unit,
		       es.frequency, es.adjustment, es.source_key, es.licence,
		       o.period, o.value
		FROM economic_series es
		JOIN LATERAL (
			SELECT period, value
			FROM economic_observations ob
			WHERE ob.series_id = es.id AND ob.period >= $2
			ORDER BY ob.period DESC
			LIMIT 600
		) o ON TRUE
		WHERE es.series_key = ANY($1)
		ORDER BY es.series_key, o.period ASC`

	rows, err := s.db.Query(ctx, query, seriesKeys, startPeriod)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byKey := map[string]*EconomicSeriesDataRow{}
	var order []string
	for rows.Next() {
		var info EconomicSeriesRow
		var p EconomicObservationRow
		if err := rows.Scan(&info.SeriesKey, &info.Topic, &info.Metric, &info.Product,
			&info.RegionType, &info.RegionCode, &info.RegionName, &info.Unit,
			&info.Frequency, &info.Adjustment, &info.SourceKey, &info.SourceLicence,
			&p.Period, &p.Value); err != nil {
			return nil, err
		}
		d, ok := byKey[info.SeriesKey]
		if !ok {
			d = &EconomicSeriesDataRow{Info: info}
			byKey[info.SeriesKey] = d
			order = append(order, info.SeriesKey)
		}
		d.Points = append(d.Points, p)
	}
	out := make([]*EconomicSeriesDataRow, 0, len(order))
	for _, k := range order {
		d := byKey[k]
		d.Info.LatestPeriod = d.Points[len(d.Points)-1].Period
		out = append(out, d)
	}
	return out, rows.Err()
}
```

(Note: `startPeriod` zero value `time.Time{}` marshals as year 1 — every observation satisfies `period >= $2`, so no special-casing needed.)

- [ ] **Step 2: Add to the Store interface** in `services/shorts/internal/store/shorts/store.go` (after the housing methods, ~line 189):

```go
	// Economy snapshot methods
	ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*EconomicSeriesRow, error)
	GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*EconomicSeriesDataRow, error)
```

- [ ] **Step 3: Mirror in the service-layer interface** `services/shorts/internal/services/shorts/interfaces.go` (Store interface, ~line 125):

```go
	// Economy snapshot methods
	ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*shortsstore.EconomicSeriesRow, error)
	GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*shortsstore.EconomicSeriesDataRow, error)
```

And in the Cache interface (~line 169):

```go
	ListEconomicSeriesKey(topic, metric, regionType, regionCode, product string, limit int32) string
	GetEconomicSeriesKey(seriesKeys []string, startPeriod string) string
```

- [ ] **Step 4: Adapters** in `services/shorts/internal/services/shorts/adapters.go` (~line 274):

```go
func (s *StoreAdapter) ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*shortsstore.EconomicSeriesRow, error) {
	return s.store.ListEconomicSeries(topic, metric, regionType, regionCode, product, limit)
}

func (s *StoreAdapter) GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*shortsstore.EconomicSeriesDataRow, error) {
	return s.store.GetEconomicSeries(seriesKeys, startPeriod)
}
```

- [ ] **Step 5: Cache keys** in `services/shorts/internal/services/shorts/cache.go` (~line 231):

```go
func (c *MemoryCache) ListEconomicSeriesKey(topic, metric, regionType, regionCode, product string, limit int32) string {
	return c.generateKey("economic_series_list", topic, metric, regionType, regionCode, product, fmt.Sprint(limit))
}

func (c *MemoryCache) GetEconomicSeriesKey(seriesKeys []string, startPeriod string) string {
	return c.generateKey("economic_series_get", strings.Join(seriesKeys, ","), startPeriod)
}
```

(Check cache.go's existing imports — add `strings` if absent; match `generateKey`'s existing signature, adjusting the variadic call style to the neighbouring key generators.)

- [ ] **Step 6: Regenerate mocks.** Find the generation directive first:

Run: `grep -rn "go:generate\|mockgen" services/shorts/internal/services/shorts/interfaces.go services/shorts/internal/services/shorts/mocks/mock_interfaces.go | head -3`
Run the mockgen command it shows (typically `cd services && go generate ./shorts/...`).
Expected: `mocks/mock_interfaces.go` gains the four new methods.

- [ ] **Step 7: Build**

Run: `cd services && go build -o /tmp/shorts ./shorts/... && echo BUILD_OK`
Expected: BUILD_OK. (The build FAILS until Task 12's handlers exist ONLY if the generated Connect interface is already asserted — it isn't; handler methods are additive. If the build fails citing unimplemented interface methods, proceed to Task 12 and build both together.)

- [ ] **Step 8: Commit**

```bash
git add services/shorts/internal/store/shorts/ services/shorts/internal/services/shorts/
git commit -m "feat(shorts): economy series store queries + interface plumbing"
```

---

## Task 12: Handlers — economy.go

**Files:**
- Create: `services/shorts/internal/services/shorts/economy.go`
- Test: `services/shorts/internal/services/shorts/economy_test.go`

- [ ] **Step 1: Write failing handler tests** (mirror the style of the neighbouring handler tests — check `house_prices_test.go` if present, else the closest `*_test.go` using `mocks.NewMockStore`):

```go
package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/golang/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shortedapi/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

func TestGetEconomicSeriesValidation(t *testing.T) {
	s := newTestServer(t) // reuse the package's existing test-server constructor; if none exists, construct ShortsServer with mocks as the neighbouring tests do
	_, err := s.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for empty keys, got %v", err)
	}

	tooMany := make([]string, 51)
	for i := range tooMany {
		tooMany[i] = "cpi.index.all_groups.aus"
	}
	_, err = s.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{SeriesKeys: tooMany}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for >50 keys, got %v", err)
	}
}

func TestGetEconomicSeriesHappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockStore(ctrl)
	store.EXPECT().GetEconomicSeries([]string{"rates.cash_rate_target.aus"}, gomock.Any()).Return(
		[]*shortsstore.EconomicSeriesDataRow{{
			Info: shortsstore.EconomicSeriesRow{
				SeriesKey: "rates.cash_rate_target.aus", Topic: "rates",
				Metric: "cash_rate_target", RegionType: "national", RegionCode: "aus",
				RegionName: "Australia", Unit: "percent", Frequency: "monthly",
				Adjustment: "original", SourceKey: "rba-key-indicators", SourceLicence: "CC-BY-4.0",
			},
			Points: []shortsstore.EconomicObservationRow{
				{Period: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), Value: 3.6},
			},
		}}, nil)

	s := newTestServerWithStore(t, store) // as above: reuse/construct per package convention
	resp, err := s.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
			SeriesKeys: []string{"rates.cash_rate_target.aus"},
		}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.Series) != 1 || resp.Msg.Series[0].Info.SeriesKey != "rates.cash_rate_target.aus" {
		t.Fatalf("unexpected response: %+v", resp.Msg)
	}
	if resp.Msg.Series[0].Observations[0].Value != 3.6 {
		t.Fatalf("value mismatch")
	}
}
```

(Adapt the two constructor helpers to whatever this package's existing handler tests actually use — read one before writing; do not invent a new harness.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services && go test ./shorts/internal/services/shorts/ -run TestGetEconomicSeries -v`
Expected: FAIL (handlers undefined).

- [ ] **Step 3: Implement `economy.go`:**

```go
package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shortedapi/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ListEconomicSeries returns catalog entries for the economy snapshot layer.
func (s *ShortsServer) ListEconomicSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.ListEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.ListEconomicSeriesResponse], error) {
	m := req.Msg
	cacheKey := s.cache.ListEconomicSeriesKey(m.Topic, m.Metric, m.RegionType, m.RegionCode, m.Product, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListEconomicSeries(m.Topic, m.Metric, m.RegionType, m.RegionCode, m.Product, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.EconomicSeriesInfo, 0, len(rows))
		for _, r := range rows {
			out = append(out, economicSeriesInfoProto(r))
		}
		return &shortsv1alpha1.ListEconomicSeriesResponse{Series: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListEconomicSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list economic series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListEconomicSeriesResponse)), nil
}

// GetEconomicSeries returns observations for up to 50 named series.
func (s *ShortsServer) GetEconomicSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.GetEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.GetEconomicSeriesResponse], error) {
	m := req.Msg
	if len(m.SeriesKeys) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("series_keys is required"))
	}
	if len(m.SeriesKeys) > 50 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("at most 50 series_keys per request"))
	}

	var start time.Time
	startKey := ""
	if m.StartPeriod != nil {
		start = m.StartPeriod.AsTime()
		startKey = start.Format("2006-01-02")
	}

	cacheKey := s.cache.GetEconomicSeriesKey(m.SeriesKeys, startKey)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetEconomicSeries(normalizeKeys(m.SeriesKeys), start)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.EconomicSeriesData, 0, len(rows))
		for _, r := range rows {
			obs := make([]*shortsv1alpha1.EconomicObservation, 0, len(r.Points))
			for _, p := range r.Points {
				obs = append(obs, &shortsv1alpha1.EconomicObservation{
					Period: timestamppb.New(p.Period),
					Value:  p.Value,
				})
			}
			out = append(out, &shortsv1alpha1.EconomicSeriesData{
				Info:         economicSeriesInfoProto(&r.Info),
				Observations: obs,
			})
		}
		return &shortsv1alpha1.GetEconomicSeriesResponse{Series: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetEconomicSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get economic series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetEconomicSeriesResponse)), nil
}

func economicSeriesInfoProto(r *shortsstore.EconomicSeriesRow) *shortsv1alpha1.EconomicSeriesInfo {
	info := &shortsv1alpha1.EconomicSeriesInfo{
		SeriesKey: r.SeriesKey, Topic: r.Topic, Metric: r.Metric, Product: r.Product,
		RegionType: r.RegionType, RegionCode: r.RegionCode, RegionName: r.RegionName,
		Unit: r.Unit, Frequency: r.Frequency, Adjustment: r.Adjustment,
		SourceKey: r.SourceKey, SourceLicence: r.SourceLicence,
	}
	if !r.LatestPeriod.IsZero() && r.LatestPeriod.Year() > 1 {
		info.LatestPeriod = timestamppb.New(r.LatestPeriod)
	}
	return info
}

func normalizeKeys(keys []string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		k = strings.ToLower(strings.TrimSpace(k))
		if k != "" {
			out = append(out, k)
		}
	}
	return out
}
```

- [ ] **Step 4: Run tests**

Run: `cd services && go test ./shorts/internal/services/shorts/ -run TestGetEconomicSeries -v && go build -o /tmp/shorts-svc ./shorts/... && echo BUILD_OK`
Expected: PASS + BUILD_OK.

- [ ] **Step 5: End-to-end local smoke** (backend against local DB with ingested data from Tasks 4-9):

Run: `cd services && DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./shorts &` then
`sleep 5 && lsof -nP -iTCP:9091 -sTCP:LISTEN` (verify the LISTEN pid is this process, not a stale squatter), then
`curl -sS -X POST http://localhost:9091/shorts.v1alpha1.ShortedStocksService/GetEconomicSeries -H 'Content-Type: application/json' -d '{"seriesKeys":["rates.cash_rate_target.aus"]}' | head -c 600`
Expected: JSON with `series[0].info.seriesKey == "rates.cash_rate_target.aus"` and observations. Kill the server after.

- [ ] **Step 6: Commit**

```bash
git add services/shorts/internal/services/shorts/economy.go services/shorts/internal/services/shorts/economy_test.go
git commit -m "feat(shorts): economy series RPC handlers"
```

---

## Task 13: Frontend server/client actions

**Files:**
- Create: `web/src/app/actions/getEconomy.ts`
- Create: `web/src/app/actions/client/getEconomyClient.ts`

- [ ] **Step 1: Implement `getEconomy.ts`** (mirrors `getHousing.ts`; ISR-cacheable transport):

```ts
"use server";

import { cache } from "react";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ShortedStocksService } from "@/../gen/shortedapi/shorts/v1alpha1/shorts_connect";
import type {
  GetEconomicSeriesResponse,
  ListEconomicSeriesResponse,
} from "@/../gen/shortedapi/shorts/v1alpha1/shorts_pb";
import { SERVER_SHORTS_API_URL } from "./config";
import { serverFetchWithUserAgent, withRetryAndNotFound } from "./util";

// NOTE: copy the exact import paths/names used by web/src/app/actions/getHousing.ts —
// the gen import path and the util helpers' names/locations must match that file,
// which is the source of truth for this repo's conventions.

const isrEconomyFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createEconomyClient() {
  const transport = createConnectTransport({
    fetch: isrEconomyFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

export const getEconomicSeries = cache(
  withRetryAndNotFound(
    async (seriesKeys: string[]): Promise<GetEconomicSeriesResponse> => {
      const client = createEconomyClient();
      return client.getEconomicSeries({ seriesKeys });
    },
  ),
);

export const listEconomicSeries = cache(
  withRetryAndNotFound(
    async (
      topic: string,
      metric = "",
      regionType = "",
    ): Promise<ListEconomicSeriesResponse> => {
      const client = createEconomyClient();
      return client.listEconomicSeries({ topic, metric, regionType, limit: 500 });
    },
  ),
);
```

- [ ] **Step 2: Implement `getEconomyClient.ts`** (browser variant — copy the header/structure of `web/src/app/actions/client/getHousingClient.ts` exactly, swapping the method):

```ts
// Client-side economy series fetch — relative baseUrl rides the next.config
// rewrite (no CORS). Mirror getHousingClient.ts's session-cache/backoff if present.
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ShortedStocksService } from "@/../gen/shortedapi/shorts/v1alpha1/shorts_connect";
import type { GetEconomicSeriesResponse } from "@/../gen/shortedapi/shorts/v1alpha1/shorts_pb";

const transport = createConnectTransport({ baseUrl: "" });
const client = createClient(ShortedStocksService, transport);

export async function getEconomicSeriesClient(
  seriesKeys: string[],
): Promise<GetEconomicSeriesResponse> {
  return client.getEconomicSeries({ seriesKeys });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -i econom` (empty output = clean) and fix any import-path mismatches against getHousing.ts/getHousingClient.ts.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/actions/getEconomy.ts web/src/app/actions/client/getEconomyClient.ts
git commit -m "feat(web): economy series server + client actions"
```

---

## Task 14: `/economy` page + chart components

**Files:**
- Create: `web/src/app/economy/page.tsx`
- Create: `web/src/@/components/economy/economy-charts.tsx` (dynamic ssr:false wrapper)
- Create: `web/src/@/components/economy/economy-series-chart.tsx` (client chart)
- Test: extend Jest coverage only if the page gains pure helpers; the e2e smoke in Task 16 covers rendering.

Follow `/housing` (`web/src/app/housing/page.tsx`) for layout primitives (`BigStat`/tile components, `ChartCard`, `WhenVisible`) — reuse those components if exported, otherwise copy the local pattern. All charts: single amber data hue, serializable `format` keys only.

- [ ] **Step 1: Implement `economy-series-chart.tsx`** — copy `web/src/@/components/housing/housing-series-chart.tsx` wholesale, then change: (a) data source to `getEconomicSeriesClient([seriesKey])`, (b) props to `{ seriesKey: string; ariaLabel: string; format: "aud" | "percent" | "index" | "megalitres" }`, (c) add `megalitres` to the local `FORMATTERS` map:

```ts
const FORMATTERS: Record<string, (v: number) => string> = {
  aud: (v) => `$${v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`}`,
  percent: (v) => `${v.toFixed(1)}%`,
  index: (v) => v.toFixed(1),
  megalitres: (v) => `${v >= 1000 ? `${(v / 1000).toFixed(1)}GL` : `${v.toFixed(0)}ML`}`,
};
```

Map `response.series[0].observations` to the chart's `{date, value}` points (`Number(obs.period!.seconds) * 1000` for the date — edge reads may deliver RFC3339 strings; follow whatever housing-series-chart already does with Timestamp fields).

- [ ] **Step 2: Implement `economy-charts.tsx`:**

```tsx
"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry for economy charts — dynamic(ssr:false) keeps connect-web
 * out of SSR (same pattern as housing-charts.tsx).
 */
export const EconomySeriesChart = dynamic(
  () => import("./economy-series-chart").then((m) => m.EconomySeriesChart),
  {
    ssr: false,
    loading: () => <div className="h-[280px] w-full animate-pulse rounded bg-muted" />,
  },
);
```

- [ ] **Step 3: Implement `page.tsx`.** Server component, `export const revalidate = 3600`. Tiles come from ONE `getEconomicSeries` call with the headline keys; each section's charts are client-fetched via `EconomySeriesChart` behind `WhenVisible`:

```tsx
import type { Metadata } from "next";
import { getEconomicSeries } from "@/app/actions/getEconomy";
import { EconomySeriesChart } from "@/components/economy/economy-charts";
// Reuse the tile/card/WhenVisible primitives exactly as housing/page.tsx imports them.

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Australian Economy Snapshot — GDP, inflation, labour, trade, petroleum",
  description:
    "Live snapshot of the Australian economy: GDP by state, unemployment, CPI, the RBA cash rate, trade by state and petroleum refining — from ABS, RBA and DCCEEW open data.",
};

const HEADLINE_KEYS = [
  "rates.cash_rate_target.aus",
  "cpi.annual_change.all_groups.aus",
  "labour.unemployment_rate.total.aus.seasadj",
  "trade.export_value.total.aus",
  "trade.import_value.total.aus",
  "gdp.gsp_chain_volume.total.nsw", // placeholder headline until national GDP series confirmed in Task 8 smoke — swap to the aus key if the flow carries it
];

function latest(series: Awaited<ReturnType<typeof getEconomicSeries>> | undefined, key: string) {
  const s = series?.series.find((d) => d.info?.seriesKey === key);
  const obs = s?.observations;
  return obs?.length ? obs[obs.length - 1]!.value : undefined;
}

export default async function EconomyPage() {
  const headline = await getEconomicSeries(HEADLINE_KEYS).catch(() => undefined);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-serif text-3xl">Australian economy</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        GDP, prices, labour, trade and petroleum — ABS, RBA and DCCEEW open data. CC-BY-4.0.
      </p>

      {/* Headline tiles — use the same BigStat/tile primitive as /housing */}
      {/* cash rate: latest(headline, "rates.cash_rate_target.aus") — "%"
          CPI yoy:   latest(headline, "cpi.annual_change.all_groups.aus") — "%"
          unemployment: latest(headline, "labour.unemployment_rate.total.aus.seasadj") — "%"
          trade balance: exports minus imports latest values — "$B" */}

      {/* Macro section */}
      {/* <ChartCard title="RBA cash rate target" subtitle="RBA F1.1 · monthly">
            <WhenVisible><EconomySeriesChart seriesKey="rates.cash_rate_target.aus" format="percent" ariaLabel="RBA cash rate target" /></WhenVisible>
          </ChartCard>
          ... CPI annual change (percent), unemployment by state (percent) ... */}

      {/* Trade section: trade.export_value.total.{wa,qld,nsw,vic} (aud) */}

      {/* Energy section: petroleum.refinery_output.{diesel_oil,automotive_gasoline,jet_fuel}.aus,
          petroleum.imports.* vs petroleum.exports.* (megalitres) */}

      {/* Source attribution list: ABS (CC-BY-4.0), RBA (CC-BY-4.0), DCCEEW (CC-BY-4.0) with links */}
    </main>
  );
}
```

Flesh the commented blocks into real JSX with the primitives housing/page.tsx uses (this is deliberate: the exact tile/card component names must be copied from that file at implementation time, not guessed here — they are local components in the housing page tree). Every chart gets a visible source line. The exact series keys for petroleum products depend on the real sheet headers from Task 9's smoke — pick the three biggest products present in `SELECT DISTINCT product FROM economic_series WHERE topic='petroleum' AND metric='refinery_output'`.

- [ ] **Step 4: Verify in the dev server**

Run: `cd web && npm run dev` (port 3020; verify LISTEN pid), open `http://localhost:3020/economy` via the Playwright MCP, screenshot, confirm: tiles show real values, charts render (client-fetch through the rewrite needs the Go backend running on 9091), attribution visible. Take before/after-style screenshot evidence.

- [ ] **Step 5: Build check**

Run: `cd web && npm run build 2>&1 | tail -20` (NEVER while the dev server runs — kill 3020 first, `rm -rf .next` if chunks corrupt).
Expected: `/economy` listed as ISR (revalidate 3600), no SSR crash (would indicate a connect-web import leak — recheck the dynamic wrapper).

- [ ] **Step 6: Commit**

```bash
git add web/src/app/economy/ web/src/@/components/economy/
git commit -m "feat(web): /economy snapshot page — tiles + macro/trade/energy charts"
```

---

## Task 15: Dockerfile, Terraform module + CI wiring

**Files:**
- Create: `services/economy-collector/Dockerfile`
- Create: `terraform/modules/economy-collector/main.tf`, `variables.tf`, `outputs.tf`
- Modify: `terraform/environments/dev/main.tf`, `terraform/environments/dev/variables.tf`
- Modify: `terraform/environments/prod/main.tf`, `terraform/environments/prod/variables.tf`
- Modify: `.github/workflows/terraform-deploy.yml` (docker matrix + 2 × `-var` + prod migration file)

- [ ] **Step 1: Dockerfile** — copy `services/house-price-collector/Dockerfile` INCLUDING the stealth stage/secret dance (the build compiles the whole `services/` module, so the private `github.com/skunkworq/stealth` dependency must resolve even though economy-collector doesn't import it). Change only the final build line and entrypoint:

```dockerfile
RUN CGO_ENABLED=0 GOOS=linux go build -o /economy-collector ./economy-collector/
...
COPY --from=builder /economy-collector /economy-collector
ENTRYPOINT ["/economy-collector"]
```

Verify locally: `docker build -f services/economy-collector/Dockerfile services -t economy-collector:test --secret id=github_token,env=GH_TOKEN` (with `GH_TOKEN` set to a PAT that reads skunkworq, or use the bind-mount variant per the house-price Dockerfile comments).

- [ ] **Step 2: Terraform module** — copy all three files from `terraform/modules/house-price-collector/`, then apply exactly these edits in `main.tf`:
  - `local.service_name = "economy-collector"`; labels `service = "economy-collector"`.
  - SA display/description strings → "Economy Collector Job" / "Service account for the ABS/RBA/DCCEEW economy collector".
  - Scheduler: name `"${local.service_name}-monthly"`, description `"Monthly ABS/RBA/DCCEEW economy ingest"`, schedule `"0 17 5 * *"` (an hour after the housing job — don't stampede the DB).
  - Header comment rewritten for this collector.
  `variables.tf` and `outputs.tf` need only the description strings updated (variable names are generic).

- [ ] **Step 3: Environment wiring.**
`terraform/environments/dev/main.tf` (after the house_price_collector block):

```hcl
# Economy collector (ABS/RBA/DCCEEW monthly ingest)
module "economy_collector" {
  source = "../../modules/economy-collector"

  project_id       = var.project_id
  region           = var.region
  scheduler_region = "australia-southeast1" # Cloud Scheduler only available in southeast1
  environment      = "production"
  image_url        = var.economy_collector_image
}
```

`terraform/environments/dev/variables.tf`:

```hcl
variable "economy_collector_image" {
  description = "Docker image URL for economy-collector job"
  type        = string
  default     = "australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/economy-collector:latest"
}
```

`terraform/environments/prod/main.tf` — same module block PLUS:

```hcl
  depends_on = [
    google_project_service.required_apis,
    google_artifact_registry_repository.shorted
  ]
```

`terraform/environments/prod/variables.tf` — same variable with default
`"australia-southeast2-docker.pkg.dev/rosy-clover-477102-t5/shorted/economy-collector:latest"`.

- [ ] **Step 4: CI wiring** in `.github/workflows/terraform-deploy.yml`:
  1. `build-docker-images` matrix (~line 286), add:
     ```yaml
          - name: economy-collector
            dockerfile: services/economy-collector/Dockerfile
            context: services
     ```
  2. Terraform Plan step (~line 473) and Terraform Apply step (~line 1114), add to BOTH:
     ```yaml
            -var="economy_collector_image=${{ env.ARTIFACT_REGISTRY }}/${{ needs.determine-environment.outputs.project-id }}/shorted/economy-collector:${{ needs.determine-environment.outputs.image-tag }}" \
     ```
  3. Prod migration block (~line 1037): add `-f /migrations/000081_add_economic_series.up.sql` to the existing `run_psql` file list. Do NOT touch the `schema_migrations` version pin — the prod flow applies by explicit file and 000081 is idempotent. (Note in the PR description that the prod migration list + pin scheme is drifting from `migrate`'s view; flagged as existing tech debt, not fixed here.)

- [ ] **Step 5: Validate**

Run: `cd terraform/environments/dev && terraform init -backend=false && terraform validate`
Expected: `Success!`. Repeat for `../prod`.

- [ ] **Step 6: Commit**

```bash
git add services/economy-collector/Dockerfile terraform/modules/economy-collector terraform/environments .github/workflows/terraform-deploy.yml
git commit -m "feat(infra): economy-collector Cloud Run job + scheduler, wired into CI"
```

---

## Task 16: Full verification + PR

- [ ] **Step 1: Full test suites**

Run: `cd services && go test ./pkg/absdata/... ./economy-collector/... ./shorts/... 2>&1 | tail -20`
Expected: all PASS.
Run: `make test-frontend` from repo root (or `cd web && npm test`).
Expected: PASS (if the lucide-react mock errors on new icons used by /economy, append them to `web/src/test/setup.ts`'s icon enumeration — known landmine).

- [ ] **Step 2: Fresh end-to-end pass on the production-consumed path**: local DB freshly ingested (`-mode all`), Go backend on 9091 (verify LISTEN pid), web dev on 3020 (verify LISTEN pid), walk `/economy` with Playwright MCP: tiles populated, one chart per section renders with data, attribution present. Screenshot as evidence.

- [ ] **Step 3: Push branch + open PR** (do NOT merge — hand to user per repo policy):

```bash
git push -u origin feat/economy-data-platform
gh pr create --title "feat: Australian economy data platform — economic series layer, economy-collector, /economy" --body "$(cat <<'EOF'
## Summary
- Migration 000081: generic `economic_series` + `economic_observations` (SDMX-shaped catalog + observations)
- `services/pkg/absdata`: shared ABS SDMX-CSV + RBA CSV clients (WAF-safe headers)
- `services/economy-collector`: 6 sources — RBA rates/FX, ABS CPI, labour force by state, merch trade by state, state accounts (GSP), DCCEEW petroleum statistics (XLSX)
- Public RPCs `ListEconomicSeries` / `GetEconomicSeries` (visibility-driven, cached, capped 50 keys × 600 obs)
- `/economy` snapshot page (ISR 3600): headline tiles + macro/trade/energy chart sections with CC-BY attribution
- Terraform: economy-collector Cloud Run Job + monthly scheduler, wired into terraform-deploy.yml image matrix + plan/apply vars; 000081 added to the prod migration file list

## Post-merge ops
- First prod ingest: `gcloud run jobs execute economy-collector --project rosy-clover-477102-t5 --region australia-southeast2` (or wait for the monthly schedule)

## Spec / plan
- docs/superpowers/specs/2026-07-21-economy-data-platform-design.md
- docs/superpowers/plans/2026-07-21-economy-data-platform.md

## Follow-ups (out of scope)
- Migrate house-price-collector + influence-collector onto pkg/absdata
- Industry-intel "economy context" strip (phase 2)
- AEMO / Resources & Energy Quarterly sources
EOF
)"
```

---

## Self-review notes (already applied)

- Spec coverage: migration (T1), absdata (T2), collector+registry (T3), six importers (T4-T9), RPCs (T10-T12), frontend (T13-T14), terraform+CI (T15), error-handling requirements (0-rows-is-error in store.go T3; per-source atomicity via tx in T3; loud layout-drift failures in T9), testing requirements (fixture unit tests per importer, handler tests, e2e smoke T16). Phase-2 industry-intel strip intentionally excluded per spec.
- The SDMX dimension codes in Tasks 5-8 are pinned by explicit probe steps with exact curl commands — the parse code is name-based and survives reorders; only the code constants need the probe values.
- Petroleum sheet names REQUIRE the Task 9 Step 1 inspection; the parser + tests encode the mechanics, the spec list gets tuned against the real workbook (called out inline).
- Task 12's test harness deliberately defers to the package's existing constructor convention (read a neighbouring test first) rather than inventing one.
