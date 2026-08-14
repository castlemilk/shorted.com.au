package news

import (
	"context"
	"fmt"
	"regexp"
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

// asxRefRe matches explicit ticker references like "ASX:LOT" or
// "(ASX: LOT)". The ASX prefix is case-insensitive; the captured code's
// casing is checked separately (must be uppercase).
var asxRefRe = regexp.MustCompile(`(?i)\bASX\s*:\s*([A-Za-z]{2,5})\b`)

// Match tries to find a stock code mentioned in a headline.
//
// ASX tickers in headlines are conventionally UPPERCASE ("LOT", "BHP").
// A bare ticker token only matches when it appears in the ORIGINAL
// headline as an exact UPPERCASE word — otherwise common-word collisions
// ("a lot of confidence" → LOT, "5 new stocks" → NEW, "should I buy" →
// BUY) produce false tags. Explicit "ASX:CODE" / "$CODE" references and
// company-name matching are exempt from the casing rule.
func (m *StockMatcher) Match(headline string) string {
	// Explicit "ASX:CODE" / "(ASX: CODE)" references — prefix any case,
	// code must be uppercase.
	for _, ref := range asxRefRe.FindAllStringSubmatch(headline, -1) {
		code := ref[1]
		if code != strings.ToUpper(code) {
			continue
		}
		if _, ok := m.codeToName[code]; ok {
			return code
		}
	}

	words := strings.Fields(headline)

	// First pass: look for ticker tokens in the original (case-preserved) headline
	for _, word := range words {
		clean := strings.Trim(word, "()[]{}:;,.'\"!?")
		// "$BHP" cashtag — strict ticker prefix always counts
		if strings.HasPrefix(clean, "$") && len(clean) >= 4 && len(clean) <= 6 {
			code := strings.ToUpper(strings.TrimPrefix(clean, "$"))
			if _, ok := m.codeToName[code]; ok {
				return code
			}
		}

		if len(clean) < 3 || len(clean) > 5 {
			continue
		}
		// Bare ticker → must be an exact UPPERCASE word in the original.
		if clean != strings.ToUpper(clean) {
			continue
		}
		if _, ok := m.codeToName[clean]; ok {
			return clean
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
