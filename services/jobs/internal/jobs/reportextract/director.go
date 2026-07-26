package reportextract

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

// directorExtractModel is extract_director_trades.py's EXTRACT_MODEL. Unlike the
// report digest, this one is NOT overridable by a flag — the script hard-codes it.
const directorExtractModel = "gemini-2.5-flash"

// directorMaxPages is the PDF page budget for a 3Y notice (they are short forms).
const directorMaxPages = 4

// directorTextChars caps the text handed to the model: "3Y notices are short —
// 6000 chars covers the form comfortably".
const directorTextChars = 6000

// Priorities — the --priority choices. "recent" is the deployed value.
const (
	priorityRecent     = "recent"
	priorityUnknown    = "unknown"
	priorityTopShorted = "top-shorted"
)

// Per-URL outcomes, used as the run tally's keys. The strings appear in logs and
// in director_extract_attempts.last_outcome, so they are a stored/observable
// contract.
const (
	outcomeOK      = "ok"
	outcomeNoPDF   = "no_pdf"
	outcomeNoExtr  = "no_extract"
	outcomeLowConf = "low_conf"
	outcomeError   = "error"
)

// minDirectorConfidence is derive_trade's gate: below it the row is left alone.
const minDirectorConfidence = 0.5

// directorExtractPrompt is extract_director_trades.py's EXTRACT_PROMPT,
// byte-for-byte (the Python source used backslash line-continuations inside a
// triple-quoted string, which produce these exact joined lines).
const directorExtractPrompt = `You extract structured data from an ASX "Appendix 3Y — Change of Director's Interest Notice". These are standardised forms. Return STRICT JSON (no markdown) with exactly these keys:

- "director_name": the FULL name of the director (a person, NOT the company). Title-case it, strip honorifics (Mr/Ms/Dr). null if you cannot find it.
- "date_of_change": ISO date YYYY-MM-DD of the change in interest, or null.
- "securities_class": e.g. "Ordinary fully paid shares", "Performance rights", or null.
- "number_acquired": integer — total securities ACQUIRED across all changes in the notice (sum the table), or null.
- "number_disposed": integer — total securities DISPOSED, or null.
- "consideration_aud": number — total dollar value / consideration in AUD across the changes, or null. Strip "$" and commas. Use null if "Nil" or not stated.
- "nature_of_change": short phrase, e.g. "On-market purchase", "On-market sale", "Exercise of options", "Vesting of performance rights", "Off-market transfer".
- "interest_type": "direct" or "indirect" or null.
- "confidence": 0.0-1.0 — your confidence the director_name + figures are correct.

If the document is NOT an Appendix 3Y, or has no identifiable director, set director_name to null and confidence 0. Output ONLY the JSON object.`

// numericStripRE is _num's `re.sub(r"[^0-9.\-]", "", ...)`.
var numericStripRE = regexp.MustCompile(`[^0-9.\-]`)

// mergedKeys is _merge_changes' non-numeric key list, in its original order.
var mergedKeys = []string{
	"director_name", "date_of_change", "securities_class",
	"nature_of_change", "interest_type", "confidence",
}

// directorRow is one selected announcement to re-extract.
type directorRow struct {
	AnnouncementURL string
	StockCode       string
	TradeDate       *string
}

// derivedTrade is the director_trades column set derive_trade produces.
type derivedTrade struct {
	DirectorName  string
	TradeType     string
	SharesTraded  int64
	TotalValue    *float64
	PricePerShare *float64
	TradeDate     *string
	Confidence    float64
}

// directorExtractor runs the structured 3Y extraction. Interface so the pipeline
// is testable without Gemini.
type directorExtractor interface {
	Extract3Y(ctx context.Context, text string) map[string]any
}

// geminiDirectorExtractor is the live implementation.
type geminiDirectorExtractor struct{ apiKey string }

// Extract3Y runs gemini structured extraction over the 3Y PDF text
// (extract_3y). Returns nil for every failure — the caller maps that to the
// "no_extract" outcome.
//
// Unlike the report digest, this call sets response_mime_type=application/json
// and temperature 0.0.
func (g geminiDirectorExtractor) Extract3Y(ctx context.Context, text string) map[string]any {
	client, err := genai.NewClient(ctx, option.WithAPIKey(g.apiKey))
	if err != nil {
		log.Printf("  gemini extract failed: %v", err)
		return nil
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel(directorExtractModel)
	model.SetTemperature(0.0)
	model.ResponseMIMEType = "application/json"
	model.SystemInstruction = &genai.Content{Parts: []genai.Part{genai.Text(directorExtractPrompt)}}

	resp, err := model.GenerateContent(ctx, genai.Text(truncateRunes(text, directorTextChars)))
	if err != nil {
		log.Printf("  gemini extract failed: %v", err)
		return nil
	}

	parsed, err := parse3YResponse(geminiText(resp))
	if err != nil {
		log.Printf("  JSON parse failed: %v", err)
		return nil
	}
	return parsed
}

// parse3YResponse strips markdown fences and decodes the payload.
//
// Some 3Y notices have several changes and the model occasionally returns a JSON
// ARRAY of change-objects instead of the requested single object; those are
// merged (quantities summed, first name kept). Anything that is neither an object
// nor an array of objects yields nil.
func parse3YResponse(raw string) (map[string]any, error) {
	raw = strings.TrimSpace(raw)
	raw = leadingFenceRE.ReplaceAllString(raw, "")
	raw = trailingFenceRE.ReplaceAllString(raw, "")
	raw = strings.TrimSpace(raw)

	var any1 any
	if err := json.Unmarshal([]byte(raw), &any1); err != nil {
		return nil, err
	}
	switch v := any1.(type) {
	case map[string]any:
		return v, nil
	case []any:
		changes := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				changes = append(changes, m)
			}
		}
		return mergeChanges(changes), nil
	default:
		return nil, nil
	}
}

// mergeChanges collapses a list of 3Y change-objects into one summed record
// (_merge_changes).
//
// The `if not out.get(k)` guard is FALSY, not "absent": a zero/empty value is
// still overwritten by a later non-null one. Reproduced with isFalsy.
func mergeChanges(changes []map[string]any) map[string]any {
	if len(changes) == 0 {
		return nil
	}
	out := map[string]any{}
	var acq, dis, val float64
	haveQty := false

	for _, c := range changes {
		for _, k := range mergedKeys {
			if v, present := c[k]; present && v != nil && isFalsy(out[k]) {
				out[k] = v
			}
		}
		a := numOrNil(c["number_acquired"])
		d := numOrNil(c["number_disposed"])
		v := numOrNil(c["consideration_aud"])
		// Python's `if a:` — a nil OR zero value is skipped.
		if a != nil && *a != 0 {
			acq += *a
			haveQty = true
		}
		if d != nil && *d != 0 {
			dis += *d
			haveQty = true
		}
		if v != nil && *v != 0 {
			val += *v
		}
	}

	// `acq or None`: a zero total becomes null.
	out["number_acquired"] = zeroToNil(acq)
	out["number_disposed"] = zeroToNil(dis)
	out["consideration_aud"] = zeroToNil(val)
	if !haveQty {
		// setdefault(…, out.get("confidence", 0.5)): only fills when the key is
		// ABSENT, in which case the default is 0.5.
		if _, present := out["confidence"]; !present {
			out["confidence"] = 0.5
		}
	}
	return out
}

// isFalsy reproduces Python truthiness for the values a JSON object can hold.
func isFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case float64:
		return t == 0
	case string:
		return t == ""
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	default:
		return false
	}
}

func zeroToNil(f float64) any {
	if f == 0 {
		return nil
	}
	return f
}

// numOrNil is extract_director_trades.py's _num.
//
// Note the asymmetry, which is faithful: a NUMERIC input returns its value
// unchanged (0 stays 0), while a STRING input is stripped of non-numeric
// characters and then `or None`'d — so "0", "$0" and "Nil" all become nil.
func numOrNil(v any) *float64 {
	switch t := v.(type) {
	case nil:
		return nil
	case float64:
		f := t
		return &f
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return nil
		}
		return &f
	case bool:
		// Python: bool is a subclass of int, so True → 1.0, False → 0.0.
		f := 0.0
		if t {
			f = 1.0
		}
		return &f
	default:
		cleaned := numericStripRE.ReplaceAllString(fmt.Sprint(v), "")
		if cleaned == "" {
			cleaned = "0"
		}
		f, err := strconv.ParseFloat(cleaned, 64)
		if err != nil {
			// Python's `except ValueError: return None`.
			return nil
		}
		if f == 0 {
			return nil
		}
		return &f
	}
}

// deriveTrade turns the extracted 3Y fields into director_trades columns
// (derive_trade). Returns nil when the row is unusable: no name, or confidence
// below 0.5.
func deriveTrade(parsed map[string]any) *derivedTrade {
	if parsed == nil {
		return nil
	}
	name := strings.TrimSpace(stringOrEmpty(parsed["director_name"]))
	conf := 0.0
	if c := numOrNil(parsed["confidence"]); c != nil {
		conf = *c
	}
	if name == "" || conf < minDirectorConfidence {
		return nil
	}

	acquired := floatOrZero(numOrNil(parsed["number_acquired"]))
	disposed := floatOrZero(numOrNil(parsed["number_disposed"]))
	consideration := numOrNil(parsed["consideration_aud"])
	nature := strings.ToLower(stringOrEmpty(parsed["nature_of_change"]))

	var (
		tradeType string
		shares    float64
	)
	switch {
	case acquired >= disposed && acquired > 0:
		tradeType, shares = "buy", acquired
	case disposed > 0:
		tradeType, shares = "sell", disposed
	default:
		// No quantity in the form (e.g. nil change / annual confirmation).
		tradeType, shares = "buy", 0
	}

	if shares > 0 && (strings.Contains(nature, "option") ||
		strings.Contains(nature, "performance right") ||
		strings.Contains(nature, "vesting")) {
		tradeType = "exercise_options"
	}

	var price *float64
	// Python's `if consideration and shares > 0` — a zero consideration is falsy.
	if consideration != nil && *consideration != 0 && shares > 0 {
		p := roundHalfEven(*consideration/shares, 4)
		price = &p
	}

	var tradeDate *string
	if s, ok := parsed["date_of_change"].(string); ok && s != "" {
		tradeDate = &s
	}

	return &derivedTrade{
		DirectorName:  name,
		TradeType:     tradeType,
		SharesTraded:  int64(shares), // Python's int(): truncation toward zero
		TotalValue:    consideration,
		PricePerShare: price,
		TradeDate:     tradeDate,
		Confidence:    conf,
	}
}

// roundHalfEven rounds to `places` decimals using banker's rounding, which is
// what Python's round() does. strconv.FormatFloat's decimal conversion rounds
// half-to-even, so a format/parse round-trip reproduces it exactly.
func roundHalfEven(v float64, places int) float64 {
	f, err := strconv.ParseFloat(strconv.FormatFloat(v, 'f', places, 64), 64)
	if err != nil {
		return v
	}
	return f
}

func stringOrEmpty(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func floatOrZero(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

// --- SQL -------------------------------------------------------------------

// attemptsTableSQL probes for the §6.9 failure-budget marker table (migration
// 000069). The job degrades gracefully when it is absent: no skipping, no
// recording.
const attemptsTableSQL = `SELECT to_regclass('public.director_extract_attempts')`

// recordAttemptSQL upserts the failure-budget marker.
const recordAttemptSQL = `
        INSERT INTO director_extract_attempts (announcement_url, attempts, last_outcome, last_attempted_at)
        VALUES ($1, 1, $2, NOW())
        ON CONFLICT (announcement_url) DO UPDATE SET
            attempts = director_extract_attempts.attempts + 1,
            last_outcome = EXCLUDED.last_outcome,
            last_attempted_at = NOW()
    `

// updateTradeSQL writes the extracted values back onto the headline-derived row.
// trade_date is COALESCE'd so a model that could not find a date leaves the
// crawler's date intact.
const updateTradeSQL = `
        UPDATE director_trades
        SET director_name = $1,
            trade_type = $2,
            shares_traded = $3,
            total_value = $4,
            price_per_share = $5,
            trade_date = COALESCE($6::date, trade_date)
        WHERE announcement_url = $7
    `

// selectDirectorURLsSQL builds select_urls' query for one priority.
//
// The §6.9 cool-off clause skips URLs attempted within retryAfterDays so the
// scheduled job CONVERGES instead of re-burning Gemini on the same persistent
// no_pdf/no_extract failures. It is only appended when the marker table exists.
//
// Both variants DISTINCT ON (announcement_url) to collapse the multiple
// director_trades rows one announcement can produce, then the outer query
// re-sorts the de-duplicated set by recency and caps it.
//
// Parameter order is significant and matches Python's: the cool-off interval (if
// present) first, then the limit.
func selectDirectorURLsSQL(priority string, withSkip bool) (string, int) {
	next := 1
	param := func() string {
		p := "$" + strconv.Itoa(next)
		next++
		return p
	}

	var base string
	if priority == priorityTopShorted {
		base = `
            SELECT DISTINCT ON (dt.announcement_url)
                   dt.announcement_url, dt.stock_code, dt.trade_date
            FROM director_trades dt
            JOIN mv_top_shorts t ON t.product_code = dt.stock_code
            WHERE dt.announcement_url ~ '^https?://'
              AND (dt.director_name = 'Unknown Director' OR dt.total_value IS NULL)
        `
		if withSkip {
			base += skipClause("dt.announcement_url", param())
		}
		base += " ORDER BY dt.announcement_url, dt.trade_date DESC"
	} else {
		base = `
            SELECT DISTINCT ON (announcement_url)
                   announcement_url, stock_code, trade_date
            FROM director_trades
            WHERE announcement_url ~ '^https?://'
              AND (director_name = 'Unknown Director' OR total_value IS NULL)
        `
		if priority == priorityUnknown {
			base += " AND director_name = 'Unknown Director'"
		}
		if withSkip {
			base += skipClause("director_trades.announcement_url", param())
		}
		base += " ORDER BY announcement_url, trade_date DESC"
	}

	return "SELECT * FROM (" + base + ") s ORDER BY trade_date DESC LIMIT " + param(), next - 1
}

// skipClause is the NOT EXISTS cool-off predicate, parameterised on the day count.
func skipClause(col, daysParam string) string {
	return " AND NOT EXISTS (SELECT 1 FROM director_extract_attempts a " +
		"WHERE a.announcement_url = " + col + " " +
		"AND a.last_attempted_at > NOW() - make_interval(days => " + daysParam + "))"
}

// directorStore is the director-trade read/write side.
type directorStore struct {
	pool *pgxpool.Pool
}

// AttemptsTableExists reports whether the §6.9 marker table is present.
func (s *directorStore) AttemptsTableExists(ctx context.Context) (bool, error) {
	var regclass *string
	if err := s.pool.QueryRow(ctx, attemptsTableSQL).Scan(&regclass); err != nil {
		return false, fmt.Errorf("probe director_extract_attempts: %w", err)
	}
	return regclass != nil, nil
}

// SelectURLs returns the announcements to re-extract, most recent first.
func (s *directorStore) SelectURLs(ctx context.Context, priority string, limit, retryAfterDays int, withSkip bool) ([]directorRow, error) {
	sql, _ := selectDirectorURLsSQL(priority, withSkip)
	args := make([]any, 0, 2)
	if withSkip {
		args = append(args, retryAfterDays)
	}
	args = append(args, limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("select director urls: %w", err)
	}
	defer rows.Close()

	var out []directorRow
	for rows.Next() {
		var r directorRow
		if err := rows.Scan(&r.AnnouncementURL, &r.StockCode, &r.TradeDate); err != nil {
			return nil, fmt.Errorf("scan director url: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate director urls: %w", err)
	}
	return out, nil
}

// RecordAttempt upserts the failure-budget marker. A failure here NEVER fails the
// run — the marker is an optimisation, not data (Python rolled the transaction
// back and moved on).
func (s *directorStore) RecordAttempt(ctx context.Context, url, outcome string) {
	if _, err := s.pool.Exec(ctx, recordAttemptSQL, url, outcome); err != nil {
		log.Printf("  attempt marker write failed for %s: %v", url, err)
	}
}

// UpdateTrade writes the derived values back onto director_trades.
func (s *directorStore) UpdateTrade(ctx context.Context, url string, d *derivedTrade) error {
	if _, err := s.pool.Exec(ctx, updateTradeSQL,
		d.DirectorName, d.TradeType, d.SharesTraded, d.TotalValue, d.PricePerShare, d.TradeDate, url,
	); err != nil {
		return fmt.Errorf("update director trade %s: %w", url, err)
	}
	return nil
}
