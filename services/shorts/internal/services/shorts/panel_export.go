package shorts

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// PanelExportPath serves the whole short-position panel for a date range in
// one request.
const PanelExportPath = "/v1/panel"

// maxPanelWindowDays bounds a single export. The dataset starts in 2010, so
// this admits the entire history in one call — it exists to reject a typo
// ("2010" for "2020" costs the origin a full scan) rather than to ration the
// data, which is the point of the endpoint.
const maxPanelWindowDays = 30 * 365

// panelExportCost is what one export charges against the caller's quota.
//
// One request here does the work of thousands of GetMarketByDate calls, so
// metering it as a single request would let the quota mean nothing.
//
// The ceiling on this number is not a matter of taste. The HTTP middleware
// charges units by calling the limiter once per unit, and the limiter's
// per-minute window is charged alongside the monthly one — so a cost at or
// above a tier's per-minute limit makes the endpoint 429 its own first
// request, permanently, for everyone in that tier. Shipped at 50 against an
// anonymous ceiling of 30, this endpoint was dead in production and healthy
// locally, where the limiter is off by default.
//
// 10 leaves an anonymous caller three exports a minute — enough to pull a
// decade in yearly slices without waiting — while still charging ten times an
// ordinary request. TestPanelExportCostCannotExceedAnyTiersPerMinuteLimit
// derives the bound from DefaultConfig so neither side can drift into the
// deadlock again.
const panelExportCost = 10

// PanelExportHandler streams the panel as CSV or NDJSON.
//
// Deliberately plain HTTP rather than a Connect RPC: the response is millions
// of rows, and a unary RPC would require the client to hold the whole thing in
// memory and us to build it there first. CSV is what lands in a dataframe with
// no code, which is the actual job.
func (s *ShortsServer) PanelExportHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writePanelError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}

		q := r.URL.Query()
		from, to := q.Get("from"), q.Get("to")
		if from == "" || to == "" {
			writePanelError(w, http.StatusBadRequest,
				"from and to are required, as YYYY-MM-DD — e.g. ?from=2015-01-01&to=2025-12-31")
			return
		}

		fromDate, err := time.Parse("2006-01-02", from)
		if err != nil {
			writePanelError(w, http.StatusBadRequest, "from must be YYYY-MM-DD")
			return
		}
		toDate, err := time.Parse("2006-01-02", to)
		if err != nil {
			writePanelError(w, http.StatusBadRequest, "to must be YYYY-MM-DD")
			return
		}
		if toDate.Before(fromDate) {
			writePanelError(w, http.StatusBadRequest, "to must not be before from")
			return
		}
		if toDate.Sub(fromDate) > maxPanelWindowDays*24*time.Hour {
			writePanelError(w, http.StatusBadRequest,
				fmt.Sprintf("window exceeds %d days; request a narrower range", maxPanelWindowDays))
			return
		}

		var codes []string
		if raw := strings.TrimSpace(q.Get("codes")); raw != "" {
			for _, c := range strings.Split(raw, ",") {
				if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
					codes = append(codes, c)
				}
			}
		}

		format := strings.ToLower(q.Get("format"))
		if format == "" {
			format = "csv"
		}
		if format != "csv" && format != "ndjson" {
			writePanelError(w, http.StatusBadRequest, `format must be "csv" or "ndjson"`)
			return
		}

		asOf := strings.TrimSpace(q.Get("as_of"))
		if asOf != "" {
			if _, err := time.Parse("2006-01-02", asOf); err != nil {
				writePanelError(w, http.StatusBadRequest, "as_of must be a valid date in YYYY-MM-DD format")
				return
			}
		}

		query := shortsstore.PanelQuery{
			From:         from,
			To:           to,
			ProductCodes: codes,
			IncludeZero:  q.Get("include_zero") == "true",
			AsOf:         asOf,
		}

		// Headers go out before the first row, so the response streams rather
		// than buffering. Once they are written the status is committed — a
		// mid-stream failure cannot become a 500, which is why the row writer
		// below reports failure in-band instead.
		filename := fmt.Sprintf("shorted-panel-%s-to-%s.%s", from, to, format)
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// No Content-Length: the row count is not known until the scan
		// finishes, and buffering to learn it defeats the point.
		w.Header().Set("Cache-Control", "public, max-age=3600")

		var rows int
		var writeErr error

		switch format {
		case "ndjson":
			w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
			enc := json.NewEncoder(w)
			writeErr = s.store.StreamPanel(r.Context(), query, func(row shortsstore.PanelRow) error {
				rows++
				return enc.Encode(panelJSON{
					Date: row.Date, AvailableFrom: row.AvailableFrom,
					Code: row.ProductCode, Name: row.ProductName,
					ShortPositions: row.ReportedShortPositions,
					SharesOnIssue:  row.TotalProductInIssue,
					PercentShorted: row.PercentShorted,
				})
			})
		default:
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			cw := csv.NewWriter(w)
			// Header names match the JSON field names on the RPC surface, so a
			// caller moving between the two is not renaming columns.
			if err := cw.Write([]string{
				"date", "available_from", "product_code", "product_name",
				"reported_short_positions", "total_product_in_issue", "percent_shorted",
			}); err != nil {
				return
			}
			writeErr = s.store.StreamPanel(r.Context(), query, func(row shortsstore.PanelRow) error {
				rows++
				return cw.Write([]string{
					row.Date, row.AvailableFrom, row.ProductCode, row.ProductName,
					strconv.FormatFloat(row.ReportedShortPositions, 'f', -1, 64),
					strconv.FormatFloat(row.TotalProductInIssue, 'f', -1, 64),
					strconv.FormatFloat(row.PercentShorted, 'f', -1, 64),
				})
			})
			cw.Flush()
			if writeErr == nil {
				writeErr = cw.Error()
			}
		}

		if writeErr != nil {
			// The status line is long gone. Truncating silently would hand a
			// researcher a short panel that looks complete, so the failure is
			// written into the body where it cannot be mistaken for data.
			s.logger.Errorf("panel export failed after %d rows: %v", rows, writeErr)
			// Ignoring this error is the only option left: the response is
			// already streaming, so there is nowhere else to report a failure
			// to write the failure marker. The log line above is the record.
			_, _ = fmt.Fprintf(w, "\n#ERROR incomplete export after %d rows: %v\n", rows, writeErr)
			return
		}

		s.logger.Debugf("panel export: %s..%s rows=%d format=%s", from, to, rows, format)
	}
}

type panelJSON struct {
	Date string `json:"date"`
	// The date this observation became public: ASIC publishes T+4. A backtest
	// using the `date` value on `date` has four days of lookahead, and nothing
	// else in the row reveals it.
	AvailableFrom  string  `json:"available_from"`
	Code           string  `json:"product_code"`
	Name           string  `json:"product_name,omitempty"`
	ShortPositions float64 `json:"reported_short_positions"`
	SharesOnIssue  float64 `json:"total_product_in_issue"`
	PercentShorted float64 `json:"percent_shorted"`
}

func writePanelError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
