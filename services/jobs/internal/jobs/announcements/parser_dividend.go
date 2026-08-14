package announcements

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DividendParseResult represents a parsed dividend from an announcement headline
type DividendParseResult struct {
	StockCode          string
	ExDate             string // YYYY-MM-DD (announcement date as proxy)
	AmountPerShare     *float64
	FrankingPercentage *float64
	DividendType       string // "ordinary", "special", "interim", "final"
}

// isDividendAnnouncement checks if an announcement relates to dividends
func isDividendAnnouncement(headline string) bool {
	lower := strings.ToLower(headline)
	return (strings.Contains(lower, "dividend") || strings.Contains(lower, "distribution")) &&
		!strings.Contains(lower, "reinvestment plan") &&
		!strings.Contains(lower, "drp") // Exclude DRP announcements
}

var (
	// Match patterns like "5.0 cents per share", "0.12 per share", "$0.05"
	amountRegex = regexp.MustCompile(`(?i)(\d+\.?\d*)\s*(?:cents?|cps|c)\s*(?:per\s*(?:share|unit))?`)
	dollarRegex = regexp.MustCompile(`(?i)\$(\d+\.?\d*)\s*(?:per\s*(?:share|unit))?`)
	// Match franking patterns like "fully franked", "100% franked", "50% franked", "unfranked"
	frankingRegex = regexp.MustCompile(`(?i)(\d+)%?\s*(?:franked|frank)`)
)

// parseDividendFromHeadline extracts dividend info from an announcement headline
func parseDividendFromHeadline(ann ASXAnnouncement, stockCode string) *DividendParseResult {
	result := &DividendParseResult{
		StockCode:    stockCode,
		ExDate:       ann.Date,
		DividendType: classifyDividendType(ann.Headline),
	}

	lower := strings.ToLower(ann.Headline)

	// Try to extract amount (in cents)
	if matches := amountRegex.FindStringSubmatch(ann.Headline); len(matches) > 1 {
		if val, err := strconv.ParseFloat(matches[1], 64); err == nil {
			// Convert cents to dollars
			amount := val / 100.0
			result.AmountPerShare = &amount
		}
	} else if matches := dollarRegex.FindStringSubmatch(ann.Headline); len(matches) > 1 {
		if val, err := strconv.ParseFloat(matches[1], 64); err == nil {
			result.AmountPerShare = &val
		}
	}

	// Try to extract franking percentage
	if strings.Contains(lower, "fully franked") {
		franking := 100.0
		result.FrankingPercentage = &franking
	} else if strings.Contains(lower, "unfranked") {
		franking := 0.0
		result.FrankingPercentage = &franking
	} else if matches := frankingRegex.FindStringSubmatch(ann.Headline); len(matches) > 1 {
		if val, err := strconv.ParseFloat(matches[1], 64); err == nil {
			result.FrankingPercentage = &val
		}
	}

	return result
}

// classifyDividendType determines the type of dividend from the headline
func classifyDividendType(headline string) string {
	lower := strings.ToLower(headline)
	switch {
	case strings.Contains(lower, "special"):
		return "special"
	case strings.Contains(lower, "interim"):
		return "interim"
	case strings.Contains(lower, "final"):
		return "final"
	default:
		return "ordinary"
	}
}

// storeDividends inserts parsed dividends into the dividend_history table
func storeDividends(ctx context.Context, db *pgxpool.Pool, dividends []*DividendParseResult, verbose bool) (int, error) {
	stored := 0
	for _, d := range dividends {
		if d.AmountPerShare == nil {
			continue // Skip dividends where we couldn't parse the amount
		}

		frankingStr := "0.0"
		if d.FrankingPercentage != nil {
			frankingStr = fmt.Sprintf("%f", *d.FrankingPercentage)
		}

		query := fmt.Sprintf(
			`INSERT INTO dividend_history (stock_code, ex_date, amount_per_share, franking_percentage, dividend_type)
			 VALUES ('%s', '%s', %f, %s, '%s')
			 ON CONFLICT (stock_code, ex_date, dividend_type) DO NOTHING`,
			escapeSQLString(d.StockCode),
			escapeSQLString(d.ExDate),
			*d.AmountPerShare,
			frankingStr,
			escapeSQLString(d.DividendType),
		)

		tag, err := db.Exec(ctx, query)
		if err != nil {
			if verbose {
				log.Printf("    WARN: failed to insert dividend for %s: %v", d.StockCode, err)
			}
			continue
		}
		if tag.RowsAffected() > 0 {
			stored++
		}
	}
	return stored, nil
}
