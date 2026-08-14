package reportextract

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// --- fixture collaborators --------------------------------------------------

type stubFetcher struct {
	text  string
	calls int
}

func (s *stubFetcher) downloadPDFText(_ context.Context, _ string, _ int) string {
	s.calls++
	return s.text
}

type stubBlobs struct {
	uploaded  map[string]string
	stored    map[string]string
	uploadURI string
}

func newStubBlobs() *stubBlobs {
	return &stubBlobs{uploaded: map[string]string{}, stored: map[string]string{}, uploadURI: "gs://bucket/obj.txt"}
}

func (s *stubBlobs) UploadRawText(_ context.Context, code, url, text string) string {
	s.uploaded[code+"|"+url] = text
	return s.uploadURI
}

func (s *stubBlobs) DownloadText(_ context.Context, uri string) string { return s.stored[uri] }

type storedRow struct {
	report        report
	metrics       map[string]any
	rawTextLength int
	digest        digestResult
	gcsURL        string
}

type stubStore struct {
	rows []storedRow
	err  error
}

func (s *stubStore) StoreExtraction(_ context.Context, r report, metrics map[string]any, n int, d digestResult, gcs string) error {
	if s.err != nil {
		return s.err
	}
	s.rows = append(s.rows, storedRow{report: r, metrics: metrics, rawTextLength: n, digest: d, gcsURL: gcs})
	return nil
}

type stubSummarizer struct {
	result     digestResult
	sawMetrics []map[string]any
}

func (s *stubSummarizer) Summarize(_ context.Context, metrics map[string]any, _, _ string) digestResult {
	s.sawMetrics = append(s.sawMetrics, metrics)
	return s.result
}

func newTestPipeline(text string, extractions []extraction, digest digestResult) (*pipeline, *stubFetcher, *stubBlobs, *stubStore, *stubSummarizer) {
	f := &stubFetcher{text: text}
	b := newStubBlobs()
	st := &stubStore{}
	sm := &stubSummarizer{result: digest}
	p := &pipeline{
		fetch:  f,
		blobs:  b,
		store:  st,
		summar: sm,
		extractFn: func(context.Context, string, string, string) []extraction {
			return extractions
		},
		model:    "gemini-2.5-flash",
		maxPages: 6,
	}
	return p, f, b, st, sm
}

// --- extraction-result → row mapping ---------------------------------------

func TestProcessConcurrentWithMetrics(t *testing.T) {
	p, _, blobs, store, summ := newTestPipeline(
		strings.Repeat("report body ", 100),
		[]extraction{{Class: "revenue", Text: "Revenue was $5,142 million", Attributes: map[string]any{"value_millions": "5142"}}},
		digestResult{Digest: "Revenue up.", Confidence: 0.8},
	)
	r := report{StockCode: "BHP", URL: "https://asx/u1", Title: "Annual Report", Date: "2025-09-01", Type: "annual_report"}

	if got := p.processConcurrent(context.Background(), r); got != outcomeOK {
		t.Fatalf("outcome = %q, want %q", got, outcomeOK)
	}
	if len(store.rows) != 1 {
		t.Fatalf("want 1 stored row, got %d", len(store.rows))
	}
	row := store.rows[0]
	rev, ok := row.metrics["revenue"].(map[string]any)
	if !ok || rev["source_text"] != "Revenue was $5,142 million" || rev["value_millions"] != "5142" {
		t.Errorf("extraction→metrics mapping wrong: %v", row.metrics)
	}
	if row.rawTextLength != runeLen(p.fetch.(*stubFetcher).text) {
		t.Errorf("raw_text_length must be the CHAR count: got %d", row.rawTextLength)
	}
	if row.digest.Digest != "Revenue up." || row.gcsURL != blobs.uploadURI {
		t.Errorf("digest/gcs not threaded through: %+v", row)
	}
	// The digest sees the STRUCTURED metrics when there are any.
	if len(summ.sawMetrics) != 1 || len(summ.sawMetrics[0]) != 1 {
		t.Errorf("summarizer should receive the metrics map, got %v", summ.sawMetrics)
	}
}

// §6.3(b) No metrics still produces a digest from raw text — the outcome key
// distinguishes the two so the run tally stays meaningful.
func TestProcessConcurrentDigestOnlyAndNoMetrics(t *testing.T) {
	longText := strings.Repeat("x", minDigestChars)

	p, _, _, store, _ := newTestPipeline(longText, nil, digestResult{Digest: "Cover note.", Confidence: 0.2})
	if got := p.processConcurrent(context.Background(), report{StockCode: "AAA"}); got != outcomeDigestOnly {
		t.Errorf("outcome = %q, want %q", got, outcomeDigestOnly)
	}
	if len(store.rows[0].metrics) != 0 {
		t.Errorf("metrics must be stored as an empty object, got %v", store.rows[0].metrics)
	}

	p, _, _, _, _ = newTestPipeline(longText, nil, digestResult{})
	if got := p.processConcurrent(context.Background(), report{StockCode: "AAA"}); got != outcomeNoMetrics {
		t.Errorf("outcome = %q, want %q", got, outcomeNoMetrics)
	}

	// Below MIN_DIGEST_CHARS the digest call is skipped entirely.
	p, _, _, _, summ := newTestPipeline(strings.Repeat("x", minDigestChars-1), nil, digestResult{Digest: "nope"})
	if got := p.processConcurrent(context.Background(), report{StockCode: "AAA"}); got != outcomeNoMetrics {
		t.Errorf("outcome = %q, want %q", got, outcomeNoMetrics)
	}
	if len(summ.sawMetrics) != 0 {
		t.Error("summarizer must not be called for text below MIN_DIGEST_CHARS")
	}
}

func TestProcessConcurrentNoPDF(t *testing.T) {
	p, _, _, store, _ := newTestPipeline("", nil, digestResult{})
	if got := p.processConcurrent(context.Background(), report{StockCode: "AAA"}); got != outcomeNoPDF {
		t.Errorf("outcome = %q, want %q", got, outcomeNoPDF)
	}
	if len(store.rows) != 0 {
		t.Error("a failed PDF must not write a row")
	}
}

func TestProcessConcurrentStoreFailureIsCountedNotFatal(t *testing.T) {
	p, _, _, store, _ := newTestPipeline(strings.Repeat("x", 500),
		[]extraction{{Class: "eps", Text: "EPS 1c"}}, digestResult{Digest: "d"})
	store.err = errors.New("boom")
	if got := p.processConcurrent(context.Background(), report{StockCode: "AAA"}); got != outcomeError {
		t.Errorf("outcome = %q, want %q", got, outcomeError)
	}
}

// --- digest backfill --------------------------------------------------------

func TestProcessDigestlessPrefersStoredGCSText(t *testing.T) {
	p, fetch, blobs, store, summ := newTestPipeline("", nil, digestResult{Digest: "From GCS.", Confidence: 0.6})
	blobs.stored["gs://b/o.txt"] = strings.Repeat("y", 900)

	r := report{
		StockCode:     "CBA",
		URL:           "https://asx/old-2024",
		RawTextGCSURL: "gs://b/o.txt",
		Metrics:       `{"revenue":{"source_text":"Revenue $1m","value_millions":"1"}}`,
	}
	if got := p.processDigestless(context.Background(), r); got != outcomeOKGCS {
		t.Fatalf("outcome = %q, want %q", got, outcomeOKGCS)
	}
	if fetch.calls != 0 {
		t.Error("the PDF must NOT be re-downloaded when GCS has the text (2024 URLs no longer resolve)")
	}
	if len(summ.sawMetrics) != 1 || summ.sawMetrics[0]["revenue"] == nil {
		t.Errorf("stored metrics must be parsed and passed to the summarizer: %v", summ.sawMetrics)
	}
	if store.rows[0].gcsURL != "gs://b/o.txt" {
		t.Errorf("existing GCS pointer must be preserved, got %q", store.rows[0].gcsURL)
	}
}

func TestProcessDigestlessFallsBackToPDFAndBackfillsThePointer(t *testing.T) {
	p, fetch, blobs, store, _ := newTestPipeline(strings.Repeat("z", 900), nil, digestResult{Digest: "From PDF."})

	r := report{StockCode: "CSL", URL: "https://asx/u", Metrics: "not json"}
	if got := p.processDigestless(context.Background(), r); got != outcomeOKPDF {
		t.Fatalf("outcome = %q, want %q", got, outcomeOKPDF)
	}
	if fetch.calls != 1 {
		t.Errorf("want one PDF download, got %d", fetch.calls)
	}
	if store.rows[0].gcsURL != blobs.uploadURI {
		t.Errorf("a re-download must backfill the GCS pointer, got %q", store.rows[0].gcsURL)
	}
	if len(store.rows[0].metrics) != 0 {
		t.Errorf("unparseable stored metrics must degrade to {}, got %v", store.rows[0].metrics)
	}
}

func TestProcessDigestlessNoTextAndNoDigest(t *testing.T) {
	p, _, _, store, _ := newTestPipeline("", nil, digestResult{Digest: "d"})
	if got := p.processDigestless(context.Background(), report{URL: "u"}); got != outcomeNoText {
		t.Errorf("outcome = %q, want %q", got, outcomeNoText)
	}

	p, _, _, _, _ = newTestPipeline(strings.Repeat("z", 900), nil, digestResult{})
	if got := p.processDigestless(context.Background(), report{URL: "u"}); got != outcomeNoDigest {
		t.Errorf("outcome = %q, want %q", got, outcomeNoDigest)
	}
	if len(store.rows) != 0 {
		t.Error("no digest → no write")
	}
}

// --- sequential accounting --------------------------------------------------

func TestProcessSequentialAccounting(t *testing.T) {
	// metrics → processed + extracted
	p, _, _, _, _ := newTestPipeline(strings.Repeat("x", 900),
		[]extraction{{Class: "revenue", Text: "r"}}, digestResult{Digest: "d"})
	processed, extracted, err := p.processSequential(context.Background(), report{StockCode: "A"})
	if err != nil || !processed || !extracted {
		t.Errorf("metrics path: processed=%v extracted=%v err=%v", processed, extracted, err)
	}

	// no metrics + a digest → processed + extracted
	p, _, _, _, _ = newTestPipeline(strings.Repeat("x", 900), nil, digestResult{Digest: "d"})
	processed, extracted, _ = p.processSequential(context.Background(), report{StockCode: "A"})
	if !processed || !extracted {
		t.Errorf("digest-only path: processed=%v extracted=%v", processed, extracted)
	}

	// no metrics + no digest → processed, NOT extracted
	p, _, _, _, _ = newTestPipeline(strings.Repeat("x", 900), nil, digestResult{})
	processed, extracted, _ = p.processSequential(context.Background(), report{StockCode: "A"})
	if !processed || extracted {
		t.Errorf("no-digest path: processed=%v extracted=%v", processed, extracted)
	}

	// no PDF → error, no write
	p, _, _, store, _ := newTestPipeline("", nil, digestResult{})
	processed, extracted, _ = p.processSequential(context.Background(), report{StockCode: "A"})
	if processed || extracted || len(store.rows) != 0 {
		t.Errorf("no-pdf path: processed=%v extracted=%v rows=%d", processed, extracted, len(store.rows))
	}
}

func TestRunSequentialStopsOnCancellation(t *testing.T) {
	p, _, _, _, _ := newTestPipeline(strings.Repeat("x", 900), nil, digestResult{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	// A long inter-report delay: SIGTERM must land during it, not after it.
	err := runSequential(ctx, p, []report{{StockCode: "A"}, {StockCode: "B"}}, time.Hour)
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled run must report an error, got %v", err)
	}
}

// --- director pipeline ------------------------------------------------------

type stubDirectorExtractor struct{ result map[string]any }

func (s stubDirectorExtractor) Extract3Y(context.Context, string) map[string]any { return s.result }

func TestDirectorProcessOneOutcomes(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		parsed map[string]any
		want   string
	}{
		{name: "no pdf", text: "", want: outcomeNoPDF},
		{name: "no extract", text: "3Y form", parsed: nil, want: outcomeNoExtr},
		{
			name:   "low confidence leaves the row alone",
			text:   "3Y form",
			parsed: map[string]any{"director_name": "Ann Lee", "confidence": 0.2},
			want:   outcomeLowConf,
		},
		{
			name:   "ok",
			text:   "3Y form",
			parsed: map[string]any{"director_name": "Ann Lee", "confidence": 0.9, "number_acquired": 100.0},
			want:   outcomeOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := &directorPipeline{
				fetch:     &stubFetcher{text: tt.text},
				extractor: stubDirectorExtractor{result: tt.parsed},
				dryRun:    true, // no store needed; the write path is gated
			}
			if got := d.processOne(context.Background(), directorRow{AnnouncementURL: "https://asx/u"}); got != tt.want {
				t.Errorf("outcome = %q, want %q", got, tt.want)
			}
		})
	}
}

// --- CLI surface ------------------------------------------------------------

func TestJobsAreRegisteredWithTheExpectedShape(t *testing.T) {
	g, ok := Group().(*runner.Group)
	if !ok {
		t.Fatal("report-extract must be a runner.Group")
	}
	if g.Name() != "report-extract" {
		t.Errorf("group name = %q", g.Name())
	}
	if names := g.Sub().Names(); !reflect.DeepEqual(names, []string{"concurrent", "sequential"}) {
		t.Errorf("sub-jobs = %v, want [concurrent sequential]", names)
	}

	dt := DirectorTradesJob()
	if dt.Name() != "director-trades" {
		t.Errorf("director job name = %q", dt.Name())
	}
	// All three honour -dry-run, so a global -dry-run is accepted rather than
	// refused by the runner (which would otherwise let it silently write).
	jobs := []runner.Job{dt}
	for _, name := range g.Sub().Names() {
		sub, ok := g.Sub().Lookup(name)
		if !ok {
			t.Fatalf("sub-job %q not resolvable", name)
		}
		jobs = append(jobs, sub)
	}
	for _, j := range jobs {
		d, ok := j.(runner.DryRunAware)
		if !ok || !d.SupportsDryRun() {
			t.Errorf("%s must declare dry-run support", j.Name())
		}
	}
}

func TestHelpReturnsErrUsage(t *testing.T) {
	for _, tc := range []struct {
		name string
		fn   func(context.Context, []string) error
	}{
		{"concurrent", RunConcurrent},
		{"sequential", RunSequential},
		{"director-trades", RunDirectorTrades},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.fn(context.Background(), []string{"-h"}); !errors.Is(err, runner.ErrUsage) {
				t.Errorf("want ErrUsage, got %v", err)
			}
		})
	}
}

// argparse rejected invalid choices; the stdlib flag package does not, so the
// validation has to be explicit or a typo would silently pick a different path.
func TestInvalidChoicesAreRejected(t *testing.T) {
	if err := RunSequential(context.Background(), []string{"-mode", "top500"}); err == nil ||
		!strings.Contains(err.Error(), "invalid -mode") {
		t.Errorf("want an invalid-mode error, got %v", err)
	}
	if err := RunDirectorTrades(context.Background(), []string{"-priority", "oldest"}); err == nil ||
		!strings.Contains(err.Error(), "invalid -priority") {
		t.Errorf("want an invalid-priority error, got %v", err)
	}
}

func TestStrayPositionalArgumentIsRejected(t *testing.T) {
	for _, tc := range []struct {
		name string
		fn   func(context.Context, []string) error
	}{
		{"concurrent", RunConcurrent},
		{"sequential", RunSequential},
		{"director-trades", RunDirectorTrades},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.fn(context.Background(), []string{"top50"})
			if err == nil || !strings.Contains(err.Error(), `unexpected argument "top50"`) {
				t.Errorf("want an unexpected-argument error, got %v", err)
			}
		})
	}
}

func TestSplitCodes(t *testing.T) {
	got := splitCodes(" cba , bhp ,, csl ")
	if want := []string{"CBA", "BHP", "CSL"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if splitCodes("") != nil || splitCodes(" , ") != nil {
		t.Error("blank codes must yield nil")
	}
}

func TestFormatCountsIsStable(t *testing.T) {
	got := formatCounts(map[string]int{"ok": 3, "no_pdf": 1, "error": 2})
	if want := "{error=2 no_pdf=1 ok=3}"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := formatCounts(nil); got != "{}" {
		t.Errorf("got %q, want {}", got)
	}
}

func TestLastRunesAndFormatFloatPtr(t *testing.T) {
	if got := lastRunes("https://asx.com.au/announcement/abcdef", 6); got != "abcdef" {
		t.Errorf("lastRunes = %q", got)
	}
	if got := lastRunes("short", 40); got != "short" {
		t.Errorf("lastRunes short = %q", got)
	}
	if got := formatFloatPtr(nil); got != "None" {
		t.Errorf("nil float must render as Python's None, got %q", got)
	}
	if got := formatFloatPtr(ptr(1250.5)); got != "1250.5" {
		t.Errorf("formatFloatPtr = %q", got)
	}
}

// The runner's start/end line and the group's leaf-name plumbing must survive.
func TestGroupDispatchNamesTheLeafJob(t *testing.T) {
	g := Group().(*runner.Group)
	var out bytes.Buffer
	err := g.Dispatch(context.Background(), "shorted report-extract", []string{"concurrent", "-h"}, &out)
	if !errors.Is(err, runner.ErrUsage) {
		t.Fatalf("want ErrUsage, got %v", err)
	}
}
