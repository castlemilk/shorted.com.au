package pgsource

import (
	"context"
	"fmt"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// CompanyMeta is one stock's company-metadata facts: the name, the industry
// group the financials rule reads, the logo, and the market cap the candidate
// falls back on when the screener has none.
type CompanyMeta struct {
	Name     string
	Industry string
	LogoURL  string
	// MarketCap is key_metrics->>'market_cap' when it is a plain number of at
	// most 15 whole digits, else nil. Anything else (an exponent, a sign, a
	// word) is withheld rather than cast.
	MarketCap *float64
}

// Metadata reads "company-metadata" for every stock, keyed by upper-case code.
// A missing table is an empty map. The market cap is guarded in SQL, so one
// malformed key_metrics value costs its own market cap and nothing else.
func Metadata(ctx context.Context, db DB) (map[string]CompanyMeta, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT stock_code::text,
		       COALESCE(company_name::text, ''),
		       COALESCE(industry::text, ''),
		       COALESCE(NULLIF(logo_icon_gcs_url::text, ''), NULLIF(logo_gcs_url::text, ''), ''),
		       CASE WHEN key_metrics ->> 'market_cap' ~ '^[0-9]{1,15}(\.[0-9]+)?$'
		            THEN NULLIF((key_metrics ->> 'market_cap')::float8, 0)
		       END
		FROM "company-metadata"`)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("Metadata", err)
			return map[string]CompanyMeta{}, nil
		}
		return nil, fmt.Errorf("query company metadata: %w", err)
	}
	defer rows.Close()
	out := map[string]CompanyMeta{}
	for rows.Next() {
		var (
			code string
			m    CompanyMeta
			mc   *float64
		)
		if err := rows.Scan(&code, &m.Name, &m.Industry, &m.LogoURL, &mc); err != nil {
			return nil, fmt.Errorf("scan company metadata: %w", err)
		}
		m.MarketCap = finite(mc)
		out[strings.ToUpper(code)] = m
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate company metadata: %w", err)
	}
	return out, nil
}

// MergeMetadata attaches each candidate's metadata by code: its name, industry
// and logo when the candidate has none, and its market cap when the candidate
// has none. A nil map changes nothing. Call it before engine.PrepareCandidates,
// whose financials rule reads the industry.
func MergeMetadata(cands []engine.Candidate, meta map[string]CompanyMeta) {
	for i := range cands {
		m, ok := meta[strings.ToUpper(cands[i].StockCode)]
		if !ok {
			continue
		}
		c := &cands[i]
		if c.CompanyName == "" {
			c.CompanyName = m.Name
		}
		if c.Industry == "" {
			c.Industry = m.Industry
		}
		if c.LogoURL == "" {
			c.LogoURL = m.LogoURL
		}
		if c.MarketCap == nil && m.MarketCap != nil {
			v := *m.MarketCap
			c.MarketCap = &v
		}
	}
}
