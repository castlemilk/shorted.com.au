package shorts

import (
	"testing"
	"time"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestTrailingYieldSum(t *testing.T) {
	// Reference date for "today": 2026-10-11 (Saturday) in Sydney timezone
	referenceDate := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC) // Converts to Sydney time

	tests := []struct {
		name        string
		dividends   []*shortsstore.DividendRecord
		nowFn       func() time.Time
		expectedSum float64
		description string
	}{
		{
			name:        "includes dividend 30 days ago",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2026-09-11", AmountPerShare: 0.50}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.50,
			description: "dividend at ex_date 2026-09-11 is within (today-365d, today]",
		},
		{
			name:        "includes dividend 200 days ago",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2026-02-01", AmountPerShare: 0.75}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.75,
			description: "dividend at ex_date 2026-02-01 is within (today-365d, today]",
		},
		{
			name:        "ignores dividend 400 days ago",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2025-08-02", AmountPerShare: 0.25}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.0,
			description: "dividend at ex_date 2025-08-02 is outside (today-365d, today] window",
		},
		{
			name:        "ignores future-dated dividend",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2026-11-15", AmountPerShare: 0.60}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.0,
			description: "future ex_date is not yet in the trailing window",
		},
		{
			name: "counts multiple dividends in window",
			dividends: []*shortsstore.DividendRecord{
				{ExDate: "2026-09-11", AmountPerShare: 0.50},
				{ExDate: "2026-06-15", AmountPerShare: 0.60},
				{ExDate: "2026-03-20", AmountPerShare: 0.55},
				{ExDate: "2025-08-02", AmountPerShare: 0.40}, // Outside window
			},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 1.65, // 0.50 + 0.60 + 0.55
			description: "sum includes only dividends with ex_date in (today-365d, today]",
		},
		{
			name:        "includes today's dividend",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2026-10-11", AmountPerShare: 0.70}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.70,
			description: "ex_date equal to today is included",
		},
		{
			name: "boundary test: dividend exactly 365 days ago is excluded",
			// 365 days before 2026-10-11 is 2025-10-11 (exclusive lower bound)
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2025-10-11", AmountPerShare: 0.45}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.0,
			description: "ex_date at (today-365d) is excluded (open lower bound)",
		},
		{
			name: "boundary test: dividend 364 days ago is included",
			// 364 days before 2026-10-11 is 2025-10-12 (inclusive upper bound of the past window)
			dividends:   []*shortsstore.DividendRecord{{ExDate: "2025-10-12", AmountPerShare: 0.48}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.48,
			description: "ex_date at (today-364d) is included",
		},
		{
			name:        "empty dividend list",
			dividends:   []*shortsstore.DividendRecord{},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.0,
			description: "empty dividend list returns zero sum",
		},
		{
			name:        "invalid date format is skipped",
			dividends:   []*shortsstore.DividendRecord{{ExDate: "invalid-date", AmountPerShare: 0.50}},
			nowFn:       func() time.Time { return referenceDate },
			expectedSum: 0.0,
			description: "invalid ex_date format is gracefully skipped",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := trailingYieldSum(tt.dividends, tt.nowFn)
			// Use approximate comparison for floating point numbers
			epsilon := 1e-9
			if (got-tt.expectedSum) > epsilon || (tt.expectedSum-got) > epsilon {
				t.Errorf("trailingYieldSum() = %v, want %v (%s)", got, tt.expectedSum, tt.description)
			}
		})
	}
}

func TestParseExDate(t *testing.T) {
	tests := []struct {
		name    string
		dateStr string
		want    time.Time
		wantErr bool
	}{
		{
			name:    "valid date",
			dateStr: "2026-10-11",
			want:    time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC),
			wantErr: false,
		},
		{
			name:    "invalid format",
			dateStr: "11-10-2026",
			wantErr: true,
		},
		{
			name:    "invalid date",
			dateStr: "2026-02-30",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseExDate(tt.dateStr)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseExDate() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && !got.Equal(tt.want) {
				t.Errorf("parseExDate() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSydneyTodayDate(t *testing.T) {
	// Test that sydneyTodayDate correctly converts UTC to Sydney timezone
	// Test date: 2026-10-11 12:00:00 UTC = 2026-10-11 22:00:00 AEDT (UTC+11 during daylight saving)
	utcTime := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	nowFn := func() time.Time { return utcTime }

	got := sydneyTodayDate(nowFn)
	expected := "2026-10-11"

	if got != expected {
		t.Errorf("sydneyTodayDate() = %v, want %v", got, expected)
	}

	// Test a different date to ensure timezone conversion
	// Test date: 2026-01-05 15:00:00 UTC = 2026-01-06 02:00:00 AEDT (UTC+11, day changes)
	utcTime2 := time.Date(2026, 1, 5, 15, 0, 0, 0, time.UTC)
	nowFn2 := func() time.Time { return utcTime2 }

	got2 := sydneyTodayDate(nowFn2)
	expected2 := "2026-01-06"

	if got2 != expected2 {
		t.Errorf("sydneyTodayDate() = %v, want %v", got2, expected2)
	}
}
