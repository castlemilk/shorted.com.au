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
