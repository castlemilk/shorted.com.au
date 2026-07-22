package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// requireSDMXColumns makes schema drift explicit. Accessing a missing name in
// a map[string]int otherwise yields column zero, which can silently disable a
// parser's selection filters and ingest unrelated SDMX series.
func requireSDMXColumns(idx map[string]int, parser string, names ...string) error {
	for _, name := range names {
		if _, ok := idx[name]; !ok {
			return fmt.Errorf("%s: %s column not found — schema drift, refusing to ingest", parser, name)
		}
	}
	return nil
}

// requireSDMXRow validates the required cells before a parser evaluates any
// selection filters. Without this guard, bounds-safe Cell access can turn a
// truncated row into empty filter values and silently discard it, leaving a
// stale gap rather than surfacing upstream schema/data corruption.
func requireSDMXRow(row []string, idx map[string]int, parser string, csvRow int, names ...string) error {
	for _, name := range names {
		column, ok := idx[name]
		if !ok {
			return fmt.Errorf("%s: CSV row %d cannot resolve required %s column", parser, csvRow, name)
		}
		if column >= len(row) {
			return fmt.Errorf("%s: CSV row %d is truncated before required %s cell", parser, csvRow, name)
		}
		if strings.TrimSpace(row[column]) == "" {
			return fmt.Errorf("%s: CSV row %d has blank required %s cell", parser, csvRow, name)
		}
	}
	return nil
}

// sdmxScaleStrict returns the scale factor for a required SDMX UNIT_MULT code.
// absdata.ApplyMult deliberately tolerates blank/malformed metadata, but
// economic values would then be accepted orders of magnitude too small. The
// importers that depend on UNIT_MULT instead fail closed with row provenance.
func sdmxScaleStrict(multCell, parser string, csvRow int) (float64, error) {
	code := absdata.Code(multCell)
	if code == "" {
		return 0, fmt.Errorf("%s: CSV row %d has blank required UNIT_MULT cell", parser, csvRow)
	}
	mult, err := strconv.Atoi(code)
	if err != nil {
		return 0, fmt.Errorf("%s: CSV row %d has malformed UNIT_MULT code %q: %w", parser, csvRow, code, err)
	}
	return math.Pow10(mult), nil
}
