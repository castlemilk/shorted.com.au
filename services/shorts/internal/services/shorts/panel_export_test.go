package shorts

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"go.uber.org/mock/gomock"
)

// panelStore is a ShortsStore whose only interesting method is StreamPanel.
// Embedding the mock would drag in a gomock controller and expectations for a
// handler that touches exactly one method.
type panelStore struct {
	ShortsStore
	rows    []shortsstore.PanelRow
	gotQ    shortsstore.PanelQuery
	failAt  int // 1-based row to fail on; 0 never fails.
	failErr error
}

func (p *panelStore) StreamPanel(_ context.Context, q shortsstore.PanelQuery, fn func(shortsstore.PanelRow) error) error {
	p.gotQ = q
	for i, row := range p.rows {
		if p.failAt > 0 && i+1 == p.failAt {
			return p.failErr
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return nil
}

func panelServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	logger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(logger)
	return &ShortsServer{config: DefaultConfig(), store: store, logger: logger}
}

func sampleRows() []shortsstore.PanelRow {
	return []shortsstore.PanelRow{
		{Date: "2015-06-16", AvailableFrom: "2015-06-22", ProductCode: "AIO", ProductName: "ASCIANO LIMITED",
			ReportedShortPositions: 12_345_678, TotalProductInIssue: 975_000_000, PercentShorted: 1.2662},
		{Date: "2015-06-16", AvailableFrom: "2015-06-22", ProductCode: "BHP", ProductName: "BHP BILLITON LIMITED",
			ReportedShortPositions: 63_791_924, TotalProductInIssue: 5_084_182_500, PercentShorted: 1.2547},
	}
}

func TestPanelExportCSV(t *testing.T) {
	store := &panelStore{rows: sampleRows()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, PanelExportPath+"?from=2015-01-01&to=2015-12-31", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("Content-Type = %q, want text/csv", ct)
	}

	records, err := csv.NewReader(rec.Body).ReadAll()
	if err != nil {
		t.Fatalf("output is not valid CSV: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("got %d CSV lines, want a header and 2 rows", len(records))
	}
	wantHeader := []string{"date", "available_from", "product_code", "product_name",
		"reported_short_positions", "total_product_in_issue", "percent_shorted"}
	for i, h := range wantHeader {
		if records[0][i] != h {
			t.Errorf("header[%d] = %q, want %q", i, records[0][i], h)
		}
	}

	// A share count must not come out in scientific notation: 1.2345678e+07
	// does not parse as an integer in every consumer, and this is a file
	// people load into a dataframe without reading it first.
	if got := records[1][4]; got != "12345678" {
		t.Errorf("reported_short_positions = %q, want a plain integer", got)
	}
	if got := records[2][5]; got != "5084182500" {
		t.Errorf("total_product_in_issue = %q, want a plain integer", got)
	}
}

func TestPanelExportNDJSON(t *testing.T) {
	store := &panelStore{rows: sampleRows()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		PanelExportPath+"?from=2015-01-01&to=2015-12-31&format=ndjson", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d NDJSON lines, want 2", len(lines))
	}
	var first panelJSON
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("line 1 is not valid JSON: %v", err)
	}
	if first.Code != "AIO" || first.Date != "2015-06-16" {
		t.Errorf("unexpected first row: %+v", first)
	}
}

func TestPanelExportPassesTheWindowThrough(t *testing.T) {
	store := &panelStore{rows: sampleRows()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		PanelExportPath+"?from=2015-01-01&to=2015-12-31&codes=bhp,+aio+&include_zero=true", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	if store.gotQ.From != "2015-01-01" || store.gotQ.To != "2015-12-31" {
		t.Errorf("window = %s..%s, want 2015-01-01..2015-12-31", store.gotQ.From, store.gotQ.To)
	}
	if !store.gotQ.IncludeZero {
		t.Error("include_zero=true must reach the store")
	}
	// Codes are upper-cased and trimmed, so a caller's "bhp" and " aio " work.
	if len(store.gotQ.ProductCodes) != 2 ||
		store.gotQ.ProductCodes[0] != "BHP" || store.gotQ.ProductCodes[1] != "AIO" {
		t.Errorf("codes = %v, want [BHP AIO]", store.gotQ.ProductCodes)
	}
}

func TestPanelExportRejectsBadRequests(t *testing.T) {
	tests := []struct {
		name  string
		query string
	}{
		{"no window at all", ""},
		{"from without to", "?from=2015-01-01"},
		{"to without from", "?to=2015-12-31"},
		{"unparseable from", "?from=last-tuesday&to=2015-12-31"},
		{"unparseable to", "?from=2015-01-01&to=soon"},
		{"reversed window", "?from=2020-01-01&to=2015-01-01"},
		{"window beyond the dataset's life", "?from=1900-01-01&to=2026-01-01"},
		{"unknown format", "?from=2015-01-01&to=2015-12-31&format=parquet"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &panelStore{rows: sampleRows()}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, PanelExportPath+tc.query, nil)

			panelServer(t, store).PanelExportHandler()(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
			}
			// A rejection must not look like an empty export.
			if strings.HasPrefix(rec.Header().Get("Content-Type"), "text/csv") {
				t.Error("a rejected request must not be served as CSV")
			}
		})
	}
}

// Headers are committed before the first row, so a mid-stream database failure
// cannot become a 500. Silently truncating would hand a researcher a short
// panel that looks complete — the worst possible outcome for this endpoint.
func TestPanelExportMarksATruncatedStream(t *testing.T) {
	store := &panelStore{rows: sampleRows(), failAt: 2, failErr: context.DeadlineExceeded}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, PanelExportPath+"?from=2015-01-01&to=2015-12-31", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "#ERROR") {
		t.Errorf("a truncated export must say so in the body, got:\n%s", body)
	}
	if !strings.Contains(body, "incomplete") {
		t.Errorf("the marker must name the problem, got:\n%s", body)
	}
}

func TestPanelExportRejectsNonGET(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, PanelExportPath+"?from=2015-01-01&to=2015-12-31", nil)

	panelServer(t, &panelStore{}).PanelExportHandler()(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}
}

// ASIC publishes T+4, so an export for a historical window otherwise contains
// up to four days of observations nobody could have had on the dates they are
// dated. as_of is what lets a caller ask for the panel as it was KNOWN.
func TestPanelExportPassesAsOfThrough(t *testing.T) {
	store := &panelStore{rows: sampleRows()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		PanelExportPath+"?from=2015-01-01&to=2015-12-31&as_of=2015-07-01", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if store.gotQ.AsOf != "2015-07-01" {
		t.Errorf("as_of = %q, want 2015-07-01", store.gotQ.AsOf)
	}
}

func TestPanelExportRejectsAMalformedAsOf(t *testing.T) {
	for _, bad := range []string{"last-week", "2015-13-01", "2015-02-30", "20150701"} {
		t.Run(bad, func(t *testing.T) {
			store := &panelStore{rows: sampleRows()}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet,
				PanelExportPath+"?from=2015-01-01&to=2015-12-31&as_of="+bad, nil)

			panelServer(t, store).PanelExportHandler()(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("as_of=%q gave status %d, want 400", bad, rec.Code)
			}
		})
	}
}

// Every row must carry its publication date, because that is the field a
// caller checks their own lag assumption against.
func TestPanelExportCarriesAvailableFrom(t *testing.T) {
	store := &panelStore{rows: sampleRows()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		PanelExportPath+"?from=2015-01-01&to=2015-12-31&format=ndjson", nil)

	panelServer(t, store).PanelExportHandler()(rec, req)

	var first panelJSON
	line := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")[0]
	if err := json.Unmarshal([]byte(line), &first); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if first.AvailableFrom == "" {
		t.Error("available_from is empty; a row with no publication date cannot be used point-in-time")
	}
	if first.AvailableFrom <= first.Date {
		t.Errorf("available_from (%s) must be after the report date (%s)", first.AvailableFrom, first.Date)
	}
}
