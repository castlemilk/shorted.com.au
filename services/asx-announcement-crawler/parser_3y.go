package main

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DirectorTradeRecord represents a parsed director trade from an Appendix 3Y announcement
type DirectorTradeRecord struct {
	StockCode       string
	DirectorName    string
	TradeType       string // "buy", "sell", "exercise_options"
	SharesTraded    int64
	PricePerShare   *float64
	TotalValue      *float64
	TradeDate       string // YYYY-MM-DD
	AnnouncementURL string
}

// isAppendix3Y checks if an announcement is an Appendix 3Y (change of director's interest)
func isAppendix3Y(headline string) bool {
	lower := strings.ToLower(headline)
	return strings.Contains(lower, "appendix 3y") ||
		strings.Contains(lower, "change of director") ||
		strings.Contains(lower, "director interest notice")
}

// parseDirectorTradeFromHeadline extracts director trade info from the announcement headline
// ASX Appendix 3Y headlines typically look like:
// "Appendix 3Y - Change of Director's Interest Notice - J Smith"
// "Change of Director's Interest Notice"
func parseDirectorTradeFromHeadline(ann ASXAnnouncement, stockCode string) *DirectorTradeRecord {
	lower := strings.ToLower(ann.Headline)

	trade := &DirectorTradeRecord{
		StockCode:       stockCode,
		TradeDate:       ann.Date,
		AnnouncementURL: ann.PDFURL,
		TradeType:       "buy", // Default — Appendix 3Y doesn't always specify in headline
	}

	// Try to extract director name from headline
	// Pattern: "... - Director Name" or "... Director Name"
	trade.DirectorName = extractDirectorName(ann.Headline)

	// Try to determine trade type from headline
	if strings.Contains(lower, "disposal") || strings.Contains(lower, "sale") || strings.Contains(lower, "sold") {
		trade.TradeType = "sell"
	} else if strings.Contains(lower, "exercise") || strings.Contains(lower, "option") {
		trade.TradeType = "exercise_options"
	} else if strings.Contains(lower, "acquisition") || strings.Contains(lower, "purchase") || strings.Contains(lower, "bought") {
		trade.TradeType = "buy"
	}

	return trade
}

var directorNameRegex = regexp.MustCompile(`(?i)(?:notice|interest)\s*[-–—]\s*(.+?)$`)
var directorNameDashRegex = regexp.MustCompile(`(?i)appendix\s+3[yY]\s*[-–—]\s*(?:change of director['']?s? interest (?:notice)?\s*[-–—]\s*)?(.+?)$`)

// extractDirectorName tries to extract the director's name from headline patterns
func extractDirectorName(headline string) string {
	// Pattern 1: "... Notice - Director Name"
	if matches := directorNameRegex.FindStringSubmatch(headline); len(matches) > 1 {
		name := strings.TrimSpace(matches[1])
		// Filter out non-name text
		if len(name) > 2 && len(name) < 80 && !strings.Contains(strings.ToLower(name), "appendix") {
			return cleanDirectorName(name)
		}
	}

	// Pattern 2: "Appendix 3Y - Change of Director's Interest Notice - Name"
	if matches := directorNameDashRegex.FindStringSubmatch(headline); len(matches) > 1 {
		name := strings.TrimSpace(matches[1])
		if len(name) > 2 && len(name) < 80 {
			return cleanDirectorName(name)
		}
	}

	return "Unknown Director"
}

// cleanDirectorName removes common suffixes and cleans up the name
func cleanDirectorName(name string) string {
	// Remove trailing PDF metadata
	name = strings.Split(name, "(")[0]
	name = strings.TrimSpace(name)
	// Remove trailing periods
	name = strings.TrimRight(name, ".")
	return name
}

// storeDirectorTrades inserts director trades into the director_trades table
func storeDirectorTrades(ctx context.Context, db *pgxpool.Pool, trades []*DirectorTradeRecord) (int, error) {
	stored := 0
	for _, t := range trades {
		priceStr := "NULL"
		if t.PricePerShare != nil {
			priceStr = fmt.Sprintf("%f", *t.PricePerShare)
		}
		totalStr := "NULL"
		if t.TotalValue != nil {
			totalStr = fmt.Sprintf("%f", *t.TotalValue)
		}

		query := fmt.Sprintf(
			`INSERT INTO director_trades (stock_code, director_name, trade_type, shares_traded, price_per_share, total_value, trade_date, announcement_url)
			 VALUES ('%s', '%s', '%s', %d, %s, %s, '%s', '%s')
			 ON CONFLICT DO NOTHING`,
			escapeSQLString(t.StockCode),
			escapeSQLString(t.DirectorName),
			escapeSQLString(t.TradeType),
			t.SharesTraded,
			priceStr,
			totalStr,
			escapeSQLString(t.TradeDate),
			escapeSQLString(t.AnnouncementURL),
		)

		tag, err := db.Exec(ctx, query)
		if err != nil {
			if *flagVerbose {
				log.Printf("    WARN: failed to insert director trade for %s: %v", t.StockCode, err)
			}
			continue
		}
		if tag.RowsAffected() > 0 {
			stored++
		}
	}
	return stored, nil
}

// parseShareCount tries to parse a share count from a string like "1,234,567" or "1234567"
func parseShareCount(s string) int64 {
	s = strings.ReplaceAll(s, ",", "")
	s = strings.TrimSpace(s)
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
