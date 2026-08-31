package shorts

import (
	"strings"
	"time"
)

// storeTimestampLayouts are the renderings a timestamp can have by the time it
// reaches this package as a string.
//
// The store opens its pool with pgx.QueryExecModeSimpleProtocol
// (store/shorts/postgres.go), which forces every result column to the text
// format. A timestamptz therefore arrives as PostgreSQL's own rendering —
// "2026-08-31 04:05:06+00", a space instead of the "T" and a bare hour offset —
// which time.RFC3339 does not accept. Some queries additionally cast with
// ::text, and a few store methods pre-format as RFC3339, so both shapes are in
// circulation and both must parse.
//
// Ordered most specific first: layouts with fractional seconds before those
// without, so a value carrying microseconds does not lose them.
var storeTimestampLayouts = []string{
	"2006-01-02 15:04:05.999999-07:00",
	"2006-01-02 15:04:05.999999-07",
	"2006-01-02 15:04:05-07:00",
	"2006-01-02 15:04:05-07",
	"2006-01-02 15:04:05",
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02",
}

// parseStoreTimestamp parses a timestamp string as returned by the store,
// accepting both PostgreSQL's text rendering and RFC3339. It reports whether
// parsing succeeded.
//
// Callers must check the boolean rather than discarding a failure: silently
// dropping an unparseable timestamp is what removed publishedAt from every news
// article on the API and the MCP (issue #548) without any error surfacing.
func parseStoreTimestamp(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range storeTimestampLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
