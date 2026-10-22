package announcements

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

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

// storeDirectorTrades inserts the director trades not already stored.
//
// The crawl re-reads every stock's announcement history each run, so almost
// every trade it hands over is already in the table: on prod (pg_stat_statements,
// 90 days to 2026-10-21) the per-trade INSERT ran 2.63M times and stored 5,976
// rows, each call a round trip and a probe of uq_director_trades_natural
// (2026-10-21 review DBP-14). Like storeAnnouncements, it now reads the stock's
// stored natural keys once, drops the trades already there (and in-batch
// repeats), and writes the rest as parameterized multi-row INSERTs; the hand
// built literals (escapeSQLString) are gone from this path. ON CONFLICT DO
// NOTHING stays, so correctness never depends on the pre-filter. A chunk that
// fails is retried one row at a time, so one bad row costs only itself, as it
// did when every trade was its own statement.
func storeDirectorTrades(ctx context.Context, db *pgxpool.Pool, trades []*DirectorTradeRecord, verbose bool) (int, error) {
	stored := 0
	for _, group := range groupDirectorTradesByCode(trades) {
		code := group[0].StockCode
		existing, err := fetchExistingDirectorTradeKeys(ctx, db, code)
		if err != nil {
			return stored, fmt.Errorf("fetch existing director trades for %s: %w", code, err)
		}
		fresh := filterNewDirectorTrades(group, existing)
		for start := 0; start < len(fresh); start += maxInsertRowsPerStatement {
			end := min(start+maxInsertRowsPerStatement, len(fresh))
			stored += insertDirectorTrades(ctx, db, fresh[start:end], verbose)
		}
	}
	return stored, nil
}

// insertDirectorTrades writes one chunk and returns the rows stored, retrying
// row by row when the multi-row statement fails.
func insertDirectorTrades(ctx context.Context, db *pgxpool.Pool, batch []*DirectorTradeRecord, verbose bool) int {
	query, args := buildDirectorTradeInsert(batch)
	tag, err := db.Exec(ctx, query, args...)
	if err == nil {
		return int(tag.RowsAffected())
	}
	if len(batch) == 1 {
		if verbose {
			log.Printf("    WARN: failed to insert director trade for %s: %v", batch[0].StockCode, err)
		}
		return 0
	}
	stored := 0
	for _, t := range batch {
		stored += insertDirectorTrades(ctx, db, []*DirectorTradeRecord{t}, verbose)
	}
	return stored
}

// directorTradeKey is a trade's uq_director_trades_natural key (000050) within
// one stock code: director, trade date, type, shares and the announcement URL
// (the index coalesces a NULL announcement_url to the empty string).
func directorTradeKey(directorName, tradeDate, tradeType string, sharesTraded int64, announcementURL string) string {
	return strings.Join([]string{directorName, tradeDate, tradeType, strconv.FormatInt(sharesTraded, 10), announcementURL}, "\x00")
}

// fetchExistingDirectorTradeKeys loads the natural keys already stored for a
// stock code: one read through uq_director_trades_natural, which leads with
// stock_code.
func fetchExistingDirectorTradeKeys(ctx context.Context, db *pgxpool.Pool, code string) (map[string]struct{}, error) {
	rows, err := db.Query(ctx, `
		SELECT director_name, trade_date, trade_type, shares_traded, COALESCE(announcement_url, '')
		FROM director_trades
		WHERE stock_code = $1`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	existing := make(map[string]struct{})
	for rows.Next() {
		var name, tradeType, url string
		var date time.Time
		var shares int64
		if err := rows.Scan(&name, &date, &tradeType, &shares, &url); err != nil {
			return nil, err
		}
		existing[directorTradeKey(name, date.Format("2006-01-02"), tradeType, shares, url)] = struct{}{}
	}
	return existing, rows.Err()
}

// filterNewDirectorTrades drops trades whose natural key is stored or repeats
// earlier in the batch, preserving order. A trade date in another format than
// the stored YYYY-MM-DD simply never matches here; ON CONFLICT catches it.
func filterNewDirectorTrades(trades []*DirectorTradeRecord, existing map[string]struct{}) []*DirectorTradeRecord {
	seen := make(map[string]struct{}, len(trades))
	var fresh []*DirectorTradeRecord
	for _, t := range trades {
		key := directorTradeKey(t.DirectorName, t.TradeDate, t.TradeType, t.SharesTraded, t.AnnouncementURL)
		if _, ok := existing[key]; ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		fresh = append(fresh, t)
	}
	return fresh
}

// groupDirectorTradesByCode splits trades by stock code, in first-seen order.
func groupDirectorTradesByCode(trades []*DirectorTradeRecord) [][]*DirectorTradeRecord {
	index := map[string]int{}
	var groups [][]*DirectorTradeRecord
	for _, t := range trades {
		i, ok := index[t.StockCode]
		if !ok {
			i = len(groups)
			index[t.StockCode] = i
			groups = append(groups, nil)
		}
		groups[i] = append(groups[i], t)
	}
	return groups
}

// buildDirectorTradeInsert builds one multi-row, fully parameterized INSERT.
// Returns ("", nil) for an empty batch.
func buildDirectorTradeInsert(batch []*DirectorTradeRecord) (string, []any) {
	if len(batch) == 0 {
		return "", nil
	}
	const colsPerRow = 8
	values := make([]string, 0, len(batch))
	args := make([]any, 0, len(batch)*colsPerRow)
	for i, t := range batch {
		b := i*colsPerRow + 1
		values = append(values, fmt.Sprintf("($%d, $%d, $%d, $%d::bigint, $%d::numeric, $%d::numeric, $%d::date, $%d)",
			b, b+1, b+2, b+3, b+4, b+5, b+6, b+7))
		args = append(args, t.StockCode, t.DirectorName, t.TradeType, t.SharesTraded,
			t.PricePerShare, t.TotalValue, t.TradeDate, t.AnnouncementURL)
	}
	return `INSERT INTO director_trades (stock_code, director_name, trade_type, shares_traded, price_per_share, total_value, trade_date, announcement_url)
		 VALUES ` + strings.Join(values, ", ") + `
		 ON CONFLICT DO NOTHING`, args
}
