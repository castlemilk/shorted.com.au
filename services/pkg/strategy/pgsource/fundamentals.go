package pgsource

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// ListGrowth reads the mv_fundamentals_growth row of every stock, keyed by
// upper-case code. The select list is GrowthColumns, the same as the
// single-stock read. A missing view is an empty map.
func ListGrowth(ctx context.Context, db DB) (map[string]*engine.Growth, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `SELECT g.stock_code::text,`+GrowthColumns+`
	FROM mv_fundamentals_growth g`)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ListGrowth", err)
			return map[string]*engine.Growth{}, nil
		}
		return nil, fmt.Errorf("query fundamentals growth: %w", err)
	}
	defer rows.Close()
	out := map[string]*engine.Growth{}
	for rows.Next() {
		var (
			code string
			g    engine.Growth
		)
		if err := rows.Scan(append([]any{&code}, GrowthScanTargets(&g)...)...); err != nil {
			return nil, fmt.Errorf("scan fundamentals growth: %w", err)
		}
		SanitiseGrowth(&g)
		out[strings.ToUpper(code)] = &g
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fundamentals growth: %w", err)
	}
	return out, nil
}

// Fundamentals is the live fundamentals of every stock with a growth or
// quality row, one blob per code (4.9): the growth row with its appended
// columns applied, the quality row and the valuation inputs, with the
// provenance timestamps left out of the body and kept out of the hash.
func Fundamentals(ctx context.Context, db DB) (map[string]features.Fundamentals, error) {
	growth, err := ListGrowth(ctx, db)
	if err != nil {
		return nil, err
	}
	extras, err := ListExtras(ctx, db)
	if err != nil {
		return nil, err
	}
	codes := map[string]bool{}
	for c := range growth {
		codes[c] = true
	}
	for c := range extras {
		codes[c] = true
	}
	sorted := make([]string, 0, len(codes))
	for c := range codes {
		sorted = append(sorted, c)
	}
	sort.Strings(sorted)

	out := make(map[string]features.Fundamentals, len(sorted))
	for _, code := range sorted {
		fund, err := EncodeFundamentals(growth[code], extras[code])
		if err != nil {
			return nil, fmt.Errorf("encode fundamentals for %s: %w", code, err)
		}
		out[code] = fund
	}
	return out, nil
}

// EncodeFundamentals builds one stock's body from its growth row and extras
// (either may be nil) and returns the body with its hash. The growth row is
// copied, so the caller's row is untouched.
func EncodeFundamentals(g *engine.Growth, e *FundamentalsExtras) (features.Fundamentals, error) {
	body := features.FundamentalsBody{}
	if g != nil {
		gc := *g
		e.ApplyToGrowth(&gc)
		gc.FetchedAt = nil
		body.Growth = &gc
	}
	if e != nil {
		if e.Quality != nil {
			q := *e.Quality
			q.FetchedAt = nil
			body.Quality = &q
		}
		vi := e.Valuation
		body.ValuationInputs = &vi
	}
	blob, err := json.Marshal(body)
	if err != nil {
		return features.Fundamentals{}, err
	}
	sum := sha256.Sum256(blob)
	return features.Fundamentals{Hash: hex.EncodeToString(sum[:]), Blob: blob}, nil
}

// DecodeFundamentals reads a blob back into its body.
func DecodeFundamentals(blob []byte) (features.FundamentalsBody, error) {
	var body features.FundamentalsBody
	if len(blob) == 0 {
		return body, nil
	}
	if err := json.Unmarshal(blob, &body); err != nil {
		return body, fmt.Errorf("decode fundamentals blob: %w", err)
	}
	return body, nil
}
