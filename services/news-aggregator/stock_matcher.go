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

// Match tries to find a stock code mentioned in a headline
func (m *StockMatcher) Match(headline string) string {
	upper := strings.ToUpper(headline)
	words := strings.Fields(upper)

	// First pass: look for exact ASX stock code patterns (3-4 uppercase letters)
	for _, word := range words {
		// Clean punctuation
		clean := strings.Trim(word, "()[]{}:;,.'\"!?")
		if len(clean) >= 3 && len(clean) <= 4 {
			if _, ok := m.codeToName[clean]; ok {
				return clean
			}
		}
		// Check for "ASX:BHP" or "(ASX:BHP)" patterns
		if strings.HasPrefix(clean, "ASX:") {
			code := strings.TrimPrefix(clean, "ASX:")
			if _, ok := m.codeToName[code]; ok {
				return code
			}
		}
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
