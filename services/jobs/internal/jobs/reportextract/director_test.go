package reportextract

import (
	"strings"
	"testing"
)

// _num's asymmetry is faithful and load-bearing: a NUMERIC 0 stays 0, but a
// STRING "0"/"Nil"/"$0" becomes null.
func TestNumOrNil(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want *float64
	}{
		{"nil", nil, nil},
		{"float", 1234.5, ptr(1234.5)},
		{"numeric zero stays zero", 0.0, ptr(0)},
		{"dollar string", "$1,234.50", ptr(1234.50)},
		{"negative string", "-500", ptr(-500)},
		{"Nil string", "Nil", nil},
		{"zero string", "0", nil},
		{"empty string", "", nil},
		{"unparseable string", "..-.-", nil},
		{"bool true", true, ptr(1)},
		{"bool false", false, ptr(0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numOrNil(tt.in)
			switch {
			case tt.want == nil && got != nil:
				t.Fatalf("want nil, got %v", *got)
			case tt.want != nil && got == nil:
				t.Fatalf("want %v, got nil", *tt.want)
			case tt.want != nil && *got != *tt.want:
				t.Fatalf("got %v, want %v", *got, *tt.want)
			}
		})
	}
}

// The model sometimes answers with an ARRAY of change-objects instead of the
// requested single object; those are summed into one record.
func TestMergeChanges(t *testing.T) {
	got := mergeChanges([]map[string]any{
		{"director_name": nil, "number_acquired": 1000.0, "consideration_aud": 5000.0},
		{"director_name": "Jane Smith", "number_acquired": 500.0, "consideration_aud": 2500.0, "confidence": 0.9},
		{"director_name": "Someone Else", "number_disposed": 200.0, "nature_of_change": "On-market sale"},
	})

	if got["director_name"] != "Jane Smith" {
		t.Errorf("first NON-FALSY name wins: got %v", got["director_name"])
	}
	if got["number_acquired"] != 1500.0 {
		t.Errorf("acquired: got %v, want 1500", got["number_acquired"])
	}
	if got["number_disposed"] != 200.0 {
		t.Errorf("disposed: got %v, want 200", got["number_disposed"])
	}
	if got["consideration_aud"] != 7500.0 {
		t.Errorf("consideration: got %v, want 7500", got["consideration_aud"])
	}
	if got["confidence"] != 0.9 {
		t.Errorf("confidence carried from the first object that had one: got %v", got["confidence"])
	}
	if got["nature_of_change"] != "On-market sale" {
		t.Errorf("nature carried: got %v", got["nature_of_change"])
	}
}

func TestMergeChangesZeroTotalsBecomeNull(t *testing.T) {
	got := mergeChanges([]map[string]any{{"director_name": "A B", "securities_class": "Ordinary"}})
	for _, k := range []string{"number_acquired", "number_disposed", "consideration_aud"} {
		if got[k] != nil {
			t.Errorf("%s: want nil for a zero total, got %v", k, got[k])
		}
	}
	// No quantity anywhere → the 0.5 confidence default is filled in.
	if got["confidence"] != 0.5 {
		t.Errorf("want the 0.5 no-quantity default, got %v", got["confidence"])
	}
}

func TestMergeChangesEmpty(t *testing.T) {
	if got := mergeChanges(nil); got != nil {
		t.Errorf("want nil for no changes, got %v", got)
	}
}

func TestParse3YResponseHandlesFencesAndArrays(t *testing.T) {
	got, err := parse3YResponse("```json\n{\"director_name\":\"Ann Lee\",\"confidence\":0.9}\n```")
	if err != nil || got["director_name"] != "Ann Lee" {
		t.Fatalf("fenced object: got %v err=%v", got, err)
	}

	got, err = parse3YResponse(`[{"director_name":"Bo Ng","number_acquired":10,"confidence":0.8},{"number_acquired":5}]`)
	if err != nil {
		t.Fatalf("array: %v", err)
	}
	if got["director_name"] != "Bo Ng" || got["number_acquired"] != 15.0 {
		t.Errorf("array must merge: %v", got)
	}

	if _, err := parse3YResponse("nope"); err == nil {
		t.Error("want a parse error for non-JSON")
	}
	// A JSON scalar is neither an object nor an array of objects.
	if got, err := parse3YResponse(`"just a string"`); err != nil || got != nil {
		t.Errorf("scalar payload must yield nil, got %v err=%v", got, err)
	}
}

// derive_trade turns the 3Y fields into director_trades columns. Its
// buy/sell/exercise_options classification and the 0.5 confidence gate decide
// what is written back over the crawler's headline-derived rows.
func TestDeriveTrade(t *testing.T) {
	tests := []struct {
		name   string
		parsed map[string]any
		want   *derivedTrade
	}{
		{
			name:   "nil parsed",
			parsed: nil,
		},
		{
			name:   "no name",
			parsed: map[string]any{"director_name": "  ", "confidence": 0.99},
		},
		{
			name:   "confidence below the gate",
			parsed: map[string]any{"director_name": "Ann Lee", "confidence": 0.49},
		},
		{
			name: "on-market purchase",
			parsed: map[string]any{
				"director_name": " Ann Lee ", "confidence": 0.9,
				"number_acquired": 1000.0, "consideration_aud": 12500.0,
				"nature_of_change": "On-market purchase", "date_of_change": "2025-07-01",
			},
			want: &derivedTrade{DirectorName: "Ann Lee", TradeType: "buy", SharesTraded: 1000,
				TotalValue: ptr(12500), PricePerShare: ptr(12.5), TradeDate: strPtr("2025-07-01"), Confidence: 0.9},
		},
		{
			name: "disposal",
			parsed: map[string]any{
				"director_name": "Bo Ng", "confidence": 0.8,
				"number_disposed": 250.0, "consideration_aud": 1000.0, "nature_of_change": "On-market sale",
			},
			want: &derivedTrade{DirectorName: "Bo Ng", TradeType: "sell", SharesTraded: 250,
				TotalValue: ptr(1000), PricePerShare: ptr(4), Confidence: 0.8},
		},
		{
			name: "vesting reclassifies to exercise_options",
			parsed: map[string]any{
				"director_name": "Cy Ho", "confidence": 0.7,
				"number_acquired": 500.0, "nature_of_change": "Vesting of performance rights",
			},
			want: &derivedTrade{DirectorName: "Cy Ho", TradeType: "exercise_options", SharesTraded: 500, Confidence: 0.7},
		},
		{
			name: "exercise of options",
			parsed: map[string]any{
				"director_name": "Di Vo", "confidence": 0.6,
				"number_acquired": 100.0, "nature_of_change": "Exercise of options",
			},
			want: &derivedTrade{DirectorName: "Di Vo", TradeType: "exercise_options", SharesTraded: 100, Confidence: 0.6},
		},
		{
			name: "nil change is a zero-share buy with no price",
			parsed: map[string]any{
				"director_name": "Ed Wu", "confidence": 0.55,
				"consideration_aud": 900.0, "nature_of_change": "Annual confirmation",
			},
			want: &derivedTrade{DirectorName: "Ed Wu", TradeType: "buy", SharesTraded: 0,
				TotalValue: ptr(900), Confidence: 0.55},
		},
		{
			name: "acquired ties with disposed and both are zero → buy 0",
			parsed: map[string]any{
				"director_name": "Fi Xu", "confidence": 0.51,
				"number_acquired": 0.0, "number_disposed": 0.0,
			},
			want: &derivedTrade{DirectorName: "Fi Xu", TradeType: "buy", SharesTraded: 0, Confidence: 0.51},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveTrade(tt.parsed)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("want nil (row left alone), got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("want a derived trade, got nil")
			}
			if got.DirectorName != tt.want.DirectorName || got.TradeType != tt.want.TradeType ||
				got.SharesTraded != tt.want.SharesTraded || got.Confidence != tt.want.Confidence {
				t.Errorf("got %+v, want %+v", *got, *tt.want)
			}
			assertFloatPtr(t, "total_value", got.TotalValue, tt.want.TotalValue)
			assertFloatPtr(t, "price_per_share", got.PricePerShare, tt.want.PricePerShare)
			if (got.TradeDate == nil) != (tt.want.TradeDate == nil) {
				t.Errorf("trade_date presence: got %v, want %v", got.TradeDate, tt.want.TradeDate)
			}
		})
	}
}

// price_per_share is round(consideration/shares, 4) — Python's banker's
// rounding, not half-away-from-zero.
func TestRoundHalfEvenMatchesPythonRound(t *testing.T) {
	tests := []struct{ in, want float64 }{
		{2.5 / 2, 1.25},
		// Verified against CPython round(x, 4): the binary float for 1.00005
		// sits just ABOVE the decimal tie, so it rounds up — half-even only
		// bites on an exact tie, and Go's FormatFloat agrees on both.
		{1.00005, 1.0001},
		{1.00015, 1.0002},
		{0.123456, 0.1235},
		{12500.0 / 1000, 12.5},
	}
	for _, tt := range tests {
		if got := roundHalfEven(tt.in, 4); got != tt.want {
			t.Errorf("roundHalfEven(%v) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

// §6.9 The cool-off NOT EXISTS clause is what makes the DAILY scheduled job
// converge instead of re-burning Gemini on the same persistent failures.
func TestSelectDirectorURLsSQLRetryAfterDays(t *testing.T) {
	sql, params := selectDirectorURLsSQL(priorityRecent, true)
	if params != 2 {
		t.Fatalf("want 2 bind params (days, limit), got %d", params)
	}
	for _, want := range []string{
		"NOT EXISTS (SELECT 1 FROM director_extract_attempts a",
		"a.announcement_url = director_trades.announcement_url",
		"a.last_attempted_at > NOW() - make_interval(days => $1)",
		"LIMIT $2",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("missing %q in:\n%s", want, sql)
		}
	}

	// Without the marker table the clause is omitted entirely and the limit
	// moves to $1 — the table-missing path must still be a valid query.
	sql, params = selectDirectorURLsSQL(priorityRecent, false)
	if params != 1 {
		t.Fatalf("want 1 bind param, got %d", params)
	}
	if strings.Contains(sql, "director_extract_attempts") {
		t.Error("cool-off clause must be absent when the marker table is missing")
	}
	if !strings.Contains(sql, "LIMIT $1") {
		t.Errorf("limit must renumber to $1:\n%s", sql)
	}
}

func TestSelectDirectorURLsSQLPerPriority(t *testing.T) {
	recent, _ := selectDirectorURLsSQL(priorityRecent, false)
	unknown, _ := selectDirectorURLsSQL(priorityUnknown, false)
	top, _ := selectDirectorURLsSQL(priorityTopShorted, false)

	// Every variant de-duplicates per announcement then re-sorts by recency.
	for name, sql := range map[string]string{"recent": recent, "unknown": unknown, "top-shorted": top} {
		if !strings.Contains(sql, "DISTINCT ON (") {
			t.Errorf("%s: missing DISTINCT ON:\n%s", name, sql)
		}
		if !strings.Contains(sql, ") s ORDER BY trade_date DESC LIMIT") {
			t.Errorf("%s: missing outer recency re-sort:\n%s", name, sql)
		}
		if !strings.Contains(sql, `announcement_url ~ '^https?://'`) {
			t.Errorf("%s: missing URL guard:\n%s", name, sql)
		}
		if !strings.Contains(sql, "'Unknown Director'") {
			t.Errorf("%s: missing the unknown/NULL-value target predicate:\n%s", name, sql)
		}
	}

	if strings.Contains(recent, "AND director_name = 'Unknown Director'\n") {
		t.Error("recent must NOT add the unknown-only narrowing")
	}
	if !strings.Contains(unknown, " AND director_name = 'Unknown Director'") {
		t.Errorf("unknown must narrow to Unknown Director rows:\n%s", unknown)
	}
	if !strings.Contains(top, "JOIN mv_top_shorts t ON t.product_code = dt.stock_code") {
		t.Errorf("top-shorted must join mv_top_shorts:\n%s", top)
	}
}

func TestDirectorWriteSQLShapes(t *testing.T) {
	if !strings.Contains(updateTradeSQL, "trade_date = COALESCE($6::date, trade_date)") {
		t.Error("a model that found no date must leave the crawler's date intact")
	}
	if !strings.Contains(updateTradeSQL, "WHERE announcement_url = $7") {
		t.Error("director_trades rows are keyed on announcement_url")
	}
	if !strings.Contains(recordAttemptSQL, "ON CONFLICT (announcement_url) DO UPDATE SET") ||
		!strings.Contains(recordAttemptSQL, "attempts = director_extract_attempts.attempts + 1") {
		t.Errorf("attempt marker must increment on conflict:\n%s", recordAttemptSQL)
	}
	if !strings.Contains(attemptsTableSQL, "to_regclass('public.director_extract_attempts')") {
		t.Error("marker-table probe drifted")
	}
}

func TestDirectorPromptAndConstants(t *testing.T) {
	if directorExtractModel != "gemini-2.5-flash" || directorMaxPages != 4 || directorTextChars != 6000 {
		t.Errorf("director tuning drifted: model=%s pages=%d chars=%d",
			directorExtractModel, directorMaxPages, directorTextChars)
	}
	if minDirectorConfidence != 0.5 {
		t.Errorf("confidence gate drifted: %v", minDirectorConfidence)
	}
	for _, want := range []string{
		`"director_name"`, `"date_of_change"`, `"securities_class"`,
		`"number_acquired"`, `"number_disposed"`, `"consideration_aud"`,
		`"nature_of_change"`, `"interest_type"`, `"confidence"`,
		"Output ONLY the JSON object.",
	} {
		if !strings.Contains(directorExtractPrompt, want) {
			t.Errorf("3Y prompt drifted, missing: %q", want)
		}
	}
}

func ptr(f float64) *float64  { return &f }
func strPtr(s string) *string { return &s }

func assertFloatPtr(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Errorf("%s: want nil, got %v", name, *got)
	case want != nil && got == nil:
		t.Errorf("%s: want %v, got nil", name, *want)
	case want != nil && *got != *want:
		t.Errorf("%s: got %v, want %v", name, *got, *want)
	}
}
