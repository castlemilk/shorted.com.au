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
// metering it as a single request would let the quota mean nothing. It is
// deliberately far below what it replaces: the request-per-date pattern this
// exists to kill costs ~2,500 requests for a decade, and this costs 50. Cheaper
// for us to serve than the pattern it replaces, and cheap enough for the caller
// that there is no reason to go back to paging.
const panelExportCost = 50

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

		query := shortsstore.PanelQuery{
			From:         from,
			To:           to,
			ProductCodes: codes,
			IncludeZero:  q.Get("include_zero") == "true",
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
					Date: row.Date, Code: row.ProductCode, Name: row.ProductName,
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
				"date", "product_code", "product_name",
				"reported_short_positions", "total_product_in_issue", "percent_shorted",
			}); err != nil {
				return
			}
			writeErr = s.store.StreamPanel(r.Context(), query, func(row shortsstore.PanelRow) error {
				rows++
				return cw.Write([]string{
					row.Date, row.ProductCode, row.ProductName,
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
			fmt.Fprintf(w, "\n#ERROR incomplete export after %d rows: %v\n", rows, writeErr)
			return
		}

		s.logger.Debugf("panel export: %s..%s rows=%d format=%s", from, to, rows, format)
	}
}

type panelJSON struct {
	Date           string  `json:"date"`
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
