package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// StockMatcher matches headline text to ASX stock codes
type StockMatcher struct {
	// Map of company name (lowercase) -> stock code
	nameToCode map[string]string
	// Map of stock code (uppercase) -> company name
	codeToName map[string]string
}

// NewStockMatcher creates a stock matcher loaded from the database
func NewStockMatcher(ctx context.Context, db *pgxpool.Pool) (*StockMatcher, error) {
	rows, err := db.Query(ctx, `
		SELECT stock_code, COALESCE(company_name, '')
		FROM "company-metadata"
		WHERE stock_code IS NOT NULL AND stock_code != ''
	`)
	if err != nil {
		return nil, fmt.Errorf("query stock codes: %w", err)
	}
	defer rows.Close()

	m := &StockMatcher{
		nameToCode: make(map[string]string),
		codeToName: make(map[string]string),
	}

	for rows.Next() {
		var code, name string
		if err := rows.Scan(&code, &name); err != nil {
			continue
		}
		code = strings.TrimSpace(code)
		name = strings.TrimSpace(name)
		if code == "" {
			continue
		}

		m.codeToName[strings.ToUpper(code)] = name

		if name != "" {
			// Index by full name
			m.nameToCode[strings.ToLower(name)] = code

			// Index by first word of company name (e.g., "Commonwealth" -> CBA)
			words := strings.Fields(name)
			if len(words) > 0 && len(words[0]) > 3 {
				m.nameToCode[strings.ToLower(words[0])] = code
			}
		}
	}

	return m, rows.Err()
}

// Count returns the number of loaded stock codes
func (m *StockMatcher) Count() int {
	return len(m.codeToName)
}

// ambiguousCodes lists ASX tickers that are also common English words.
// For these, we only accept matches that appear in the original headline
// as ALL CAPS or ASX:<code>/$<code> — otherwise "should I buy Zip" matches
// BUY (Bounty Oil & Gas) and "5 new stocks" matches NEW (New Energy Solar).
var ambiguousCodes = map[string]bool{
	"AGO": true, "AND": true, "ARE": true, "ASX": true, "AVG": true,
	"BIG": true, "BOND": true, "BUY": true, "CEO": true, "FOR": true,
	"GOLD": true, "HAS": true, "HOT": true, "ITS": true, "NEW": true,
	"RED": true, "TOP": true, "VLW": true, "ALL": true, "ANY": true,
	"OLD": true, "LOW": true, "RAW": true, "WHY": true, "HOW": true,
	"DAY": true, "WAY": true, "ONE": true, "TWO": true, "OUT": true,
	"GET": true, "WIN": true, "BAD": true, "YOU": true, "OUR": true,
	"NOW": true, "SELL": true, "USD": true, "AUD": true, "MORE": true,
	"LESS": true, "THE": true,
}

// Match tries to find a stock code mentioned in a headline
func (m *StockMatcher) Match(headline string) string {
	// Iterate the ORIGINAL headline (case preserved). Only when the token
	// appears as ALL CAPS in the original (or with an ASX:/$ prefix) do we
	// consider a stop-word-shaped code a real ticker mention.
	words := strings.Fields(headline)

	// First pass: look for exact ASX stock code patterns (3-4 letters)
	for _, word := range words {
		clean := strings.Trim(word, "()[]{}:;,.'\"!?")
		// "ASX:BHP" / "(ASX:BHP)" / "$BHP" — strict ticker prefixes always count
		if strings.HasPrefix(strings.ToUpper(clean), "ASX:") {
			code := strings.ToUpper(strings.TrimPrefix(strings.ToUpper(clean), "ASX:"))
			if _, ok := m.codeToName[code]; ok {
				return code
			}
		}
		if strings.HasPrefix(clean, "$") && len(clean) >= 4 && len(clean) <= 6 {
			code := strings.ToUpper(strings.TrimPrefix(clean, "$"))
			if _, ok := m.codeToName[code]; ok {
				return code
			}
		}

		if len(clean) < 3 || len(clean) > 5 {
			continue
		}
		upper := strings.ToUpper(clean)
		if _, ok := m.codeToName[upper]; !ok {
			continue
		}
		// Stop-word-shaped code → require ALL CAPS in the original.
		if ambiguousCodes[upper] && clean != upper {
			continue
		}
		return upper
	}

	// Second pass: look for company names in headline
	lowerHeadline := strings.ToLower(headline)
	bestMatch := ""
	bestMatchLen := 0

	for name, code := range m.nameToCode {
		if len(name) > bestMatchLen && strings.Contains(lowerHeadline, name) {
			bestMatch = code
			bestMatchLen = len(name)
		}
	}

	return bestMatch
}
