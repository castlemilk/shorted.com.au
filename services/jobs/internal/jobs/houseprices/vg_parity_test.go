package houseprices

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

type parityNSWFetcher struct {
	responses map[string][]byte
}

func (f parityNSWFetcher) FetchBytes(_ context.Context, pageURL, _ string) ([]byte, string, error) {
	return f.responses[pageURL], nswAccept, nil
}

func parityNSWYearZIP(t *testing.T, dat string) []byte {
	t.Helper()
	var inner bytes.Buffer
	innerWriter := zip.NewWriter(&inner)
	datWriter, err := innerWriter.Create("sales.DAT")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := datWriter.Write([]byte(dat)); err != nil {
		t.Fatal(err)
	}
	if err := innerWriter.Close(); err != nil {
		t.Fatal(err)
	}

	var outer bytes.Buffer
	outerWriter := zip.NewWriter(&outer)
	weekWriter, err := outerWriter.Create("week.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := weekWriter.Write(inner.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := outerWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return outer.Bytes()
}

func parityNSWOuterZIP(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var outer bytes.Buffer
	writer := zip.NewWriter(&outer)
	member, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return outer.Bytes()
}

type parityVICResponse struct {
	body []byte
	err  error
}

type parityVICFetcher struct {
	doc       *goquery.Document
	pageURL   *url.URL
	responses map[string]parityVICResponse
	calls     []string
}

func (f *parityVICFetcher) FetchHTML(context.Context, string) (*goquery.Document, *url.URL, error) {
	return f.doc, f.pageURL, nil
}

func (f *parityVICFetcher) FetchBytes(_ context.Context, pageURL, _ string) ([]byte, string, error) {
	f.calls = append(f.calls, pageURL)
	response, ok := f.responses[pageURL]
	if !ok {
		return nil, "", fmt.Errorf("unexpected workbook URL %s", pageURL)
	}
	return response.body, xlsxAccept, response.err
}

func parityVICDocument(t *testing.T, html string) *goquery.Document {
	t.Helper()
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func parityURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestConsolidatedScheduledOfficialJobsExcludeResidentialOnlyNSW(t *testing.T) {
	var names []string
	for _, job := range scheduledOfficialJobs() {
		names = append(names, job.name)
	}
	if slicesContain(names, nswSource) {
		t.Fatalf("scheduled official jobs include residential-only %q: %v", nswSource, names)
	}
	for _, source := range []string{"vg_sa", "vg_vic"} {
		if !slicesContain(names, source) {
			t.Fatalf("scheduled official jobs = %v; missing %q", names, source)
		}
	}
}

func TestConsolidatedFreshnessPoliciesIncludeOnlyAttemptedSources(t *testing.T) {
	got := freshnessPoliciesForOfficialJobs(scheduledOfficialJobs(), vgFreshnessPolicies)
	want := []vgFreshnessPolicy{
		{source: "vg_sa", maxAgeDays: 270},
		{source: "vg_vic", maxAgeDays: 550},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scheduled freshness policies = %#v, want %#v", got, want)
	}
}

func TestConsolidatedRunNSWVGRigExitsOnAttemptedFailureWithoutRefresh(t *testing.T) {
	freshnessCalls, refreshCalls := 0, 0
	code := runNSWVGRig(
		func() bool { return false },
		func() int { freshnessCalls++; return 0 },
		func() { refreshCalls++ },
	)
	if code != 1 || freshnessCalls != 0 || refreshCalls != 0 {
		t.Fatalf("result = code %d, freshness %d, refresh %d; want 1, 0, 0", code, freshnessCalls, refreshCalls)
	}
}

func TestConsolidatedCollectorTimeoutUsesNSWOverride(t *testing.T) {
	t.Setenv("VG_NSW_TIMEOUT_MIN", "17")
	t.Setenv("CRAWL_TIMEOUT_MIN", "99")
	if got := collectorTimeoutMinutes("vg-nsw"); got != 17 {
		t.Fatalf("vg-nsw timeout = %d, want 17", got)
	}
	if got := collectorTimeoutMinutes("official"); got != 99 {
		t.Fatalf("official timeout = %d, want 99", got)
	}
}

func TestConsolidatedNSWRejectsPartialCoverage(t *testing.T) {
	years := []int{2023, 2024, 2025}
	fetcher := parityNSWFetcher{responses: map[string][]byte{
		fmt.Sprintf("%s%d.zip", nswPSIBase, 2023): parityNSWYearZIP(t, nswDATFixture),
		fmt.Sprintf("%s%d.zip", nswPSIBase, 2024): []byte("Cloudflare challenge"),
		fmt.Sprintf("%s%d.zip", nswPSIBase, 2025): []byte("Cloudflare challenge"),
	}}
	if obs, err := ingestNSWSuburbMediansWithFetcher(context.Background(), fetcher, years); err == nil {
		t.Fatalf("partial coverage returned %d observations without error", len(obs))
	} else if !strings.Contains(err.Error(), "incomplete NSW PSI coverage") {
		t.Fatalf("partial coverage error = %q", err)
	}
}

func TestConsolidatedNSWPooledMedianUsesLatestFetchedYear(t *testing.T) {
	agg := map[string]map[int]*nswAgg{
		"THINVILLE": {
			2023: {prices: []float64{1, 2, 3}, postcodes: map[string]int{"2000": 3}},
			2024: {prices: []float64{4, 5, 6}, postcodes: map[string]int{"2000": 3}},
		},
	}
	obs := buildNSWObservations(agg, []int{2023, 2024})
	if len(obs) != 1 || obs[0].Period.Year() != 2024 {
		t.Fatalf("pooled observations = %+v, want one stamped 2024", obs)
	}
}

func TestConsolidatedNSWRejectsStructurallyInvalidYear(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{name: "corrupt weekly", body: parityNSWOuterZIP(t, "week.zip", []byte("not a nested zip"))},
		{name: "DAT without qualifying sales", body: parityNSWYearZIP(t, "garbage;not;a;sale")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseNSWYearSales(tc.body); err == nil {
				t.Fatal("expected structurally invalid year to fail")
			}
		})
	}
}

func TestConsolidatedOfficialRunRejectsCursorRegressionBeforeWrites(t *testing.T) {
	persisted := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	incoming := time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)
	writes := 0
	var status string
	if runOfficialJobWith(context.Background(), officialJob{
		name: vicSource,
		fn: func(context.Context) ([]Observation, error) {
			return []Observation{{Source: vicSource, Period: incoming}}, nil
		},
	}, officialJobIO{
		lockSource:         func(context.Context, string) (func(), error) { return func() {}, nil },
		loadLastPeriod:     func(context.Context, string) (*time.Time, error) { return &persisted, nil },
		upsertRegions:      func(context.Context, []Observation) error { writes++; return nil },
		upsertObservations: func(context.Context, []Observation) (int, error) { writes++; return 1, nil },
		updateRun: func(_ context.Context, _ string, last *time.Time, _ int, gotStatus, _ string) error {
			status = gotStatus
			if last == nil || !last.Equal(persisted) {
				t.Fatalf("recorded period = %v, want persisted %v", last, persisted)
			}
			return nil
		},
	}) {
		t.Fatal("regressed run reported success")
	}
	if writes != 0 || status != "error" {
		t.Fatalf("writes/status = %d/%q, want 0/error", writes, status)
	}
}

func TestConsolidatedOfficialRunRequiresCursorPersistence(t *testing.T) {
	period := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	ok := runOfficialJobWith(context.Background(), officialJob{
		name: nswSource,
		fn: func(context.Context) ([]Observation, error) {
			return []Observation{{Source: nswSource, Period: period}}, nil
		},
	}, officialJobIO{
		lockSource:         func(context.Context, string) (func(), error) { return func() {}, nil },
		loadLastPeriod:     func(context.Context, string) (*time.Time, error) { return nil, nil },
		upsertRegions:      func(context.Context, []Observation) error { return nil },
		upsertObservations: func(context.Context, []Observation) (int, error) { return 1, nil },
		updateRun: func(context.Context, string, *time.Time, int, string, string) error {
			return fmt.Errorf("cursor write failed")
		},
	})
	if ok {
		t.Fatal("job reported success after cursor persistence failed")
	}
}

func TestConsolidatedVICFallsBackWithoutFetchingOlderDiscovery(t *testing.T) {
	older := "https://www.land.vic.gov.au/__data/houses-by-suburb-2013-2023.xlsx"
	want := vicFixture(t)
	fetcher := &parityVICFetcher{
		doc:     parityVICDocument(t, `<a href="`+older+`">earlier statistics</a>`),
		pageURL: parityURL(t, vicListingPageURL),
		responses: map[string]parityVICResponse{
			older:      {body: want},
			vicXLSXURL: {body: want},
		},
	}
	if _, err := fetchVICSuburbWorkbook(context.Background(), fetcher); err != nil {
		t.Fatal(err)
	}
	if len(fetcher.calls) != 1 || fetcher.calls[0] != vicXLSXURL {
		t.Fatalf("workbook calls = %v, want pinned fallback only", fetcher.calls)
	}
}

func TestConsolidatedVICFallsBackWithoutFetchingSameYearDiscovery(t *testing.T) {
	sameYear := "https://www.land.vic.gov.au/__data/archive/houses-by-suburb-2010-2024.xlsx"
	want := vicFixture(t)
	fetcher := &parityVICFetcher{
		doc:     parityVICDocument(t, `<a href="`+sameYear+`">alternate archive</a>`),
		pageURL: parityURL(t, vicListingPageURL),
		responses: map[string]parityVICResponse{
			sameYear:   {body: want},
			vicXLSXURL: {body: want},
		},
	}
	if _, err := fetchVICSuburbWorkbook(context.Background(), fetcher); err != nil {
		t.Fatal(err)
	}
	if len(fetcher.calls) != 1 || fetcher.calls[0] != vicXLSXURL {
		t.Fatalf("workbook calls = %v, want pinned fallback only", fetcher.calls)
	}
}

func slicesContain(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
