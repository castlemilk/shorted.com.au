package shorts

import (
	"testing"
	"time"
)

// The store runs pgx in QueryExecModeSimpleProtocol (postgres.go), so every
// timestamptz arrives as PostgreSQL's *text* rendering — "2026-08-31 04:05:06+00"
// — not RFC3339. Parsing these with time.RFC3339 alone fails, and the callers
// that did so dropped the value silently: news articles reached the API and the
// MCP with no publishedAt at all (issue #548), and subscriptions reached the
// billing UI with no currentPeriodEnd.
func TestParseStoreTimestamp(t *testing.T) {
	want := time.Date(2026, 8, 31, 4, 5, 6, 0, time.UTC)

	tests := []struct {
		name  string
		input string
		want  time.Time
		ok    bool
	}{
		// The format that actually reaches us from Postgres, and the whole
		// reason this helper exists.
		{"postgres text, hour offset", "2026-08-31 04:05:06+00", want, true},
		{"postgres text, offset with minutes", "2026-08-31 14:05:06+10:00", time.Date(2026, 8, 31, 4, 5, 6, 0, time.UTC), true},
		{"postgres text, fractional seconds", "2026-08-31 04:05:06.123456+00", want.Add(123456 * time.Microsecond), true},
		{"postgres text, no offset", "2026-08-31 04:05:06", want, true},

		// Still accepted, because some store paths already format RFC3339
		// before handing the string over (postgres.go GetSyncStatus).
		{"rfc3339", "2026-08-31T04:05:06Z", want, true},
		{"rfc3339 nano", "2026-08-31T04:05:06.123456Z", want.Add(123456 * time.Microsecond), true},
		{"rfc3339 offset", "2026-08-31T14:05:06+10:00", want, true},

		// Date-only, as produced by a ::date cast.
		{"date only", "2026-08-31", time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC), true},

		{"empty", "", time.Time{}, false},
		{"whitespace", "   ", time.Time{}, false},
		{"garbage", "not a timestamp", time.Time{}, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseStoreTimestamp(tc.input)
			if ok != tc.ok {
				t.Fatalf("parseStoreTimestamp(%q) ok = %v, want %v", tc.input, ok, tc.ok)
			}
			if !tc.ok {
				return
			}
			if !got.Equal(tc.want) {
				t.Errorf("parseStoreTimestamp(%q) = %s, want %s", tc.input, got.Format(time.RFC3339Nano), tc.want.Format(time.RFC3339Nano))
			}
		})
	}
}
