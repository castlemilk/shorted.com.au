package pgsource

import (
	"strings"
	"testing"
)

// first SELECT and the first top-level FROM of query.
func selectList(t *testing.T, query string) []string {
	t.Helper()
	upper := strings.ToUpper(query)
	start := strings.Index(upper, "SELECT")
	if start < 0 {
		t.Fatalf("no SELECT in query")
	}
	body := query[start+len("SELECT"):]
	var (
		parts []string
		depth int
		cur   strings.Builder
		inStr bool
	)
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if ch == '\'' {
			inStr = !inStr
		}
		if !inStr {
			switch ch {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth == 0 && i+6 <= len(body) && strings.EqualFold(body[i:i+6], " FROM ") ||
				depth == 0 && i+5 <= len(body) && (strings.EqualFold(body[i:i+5], "\nFROM") || strings.EqualFold(body[i:i+5], "\tFROM")) {
				parts = append(parts, strings.TrimSpace(cur.String()))
				return parts
			}
			if depth == 0 && ch == ',' {
				parts = append(parts, strings.TrimSpace(cur.String()))
				cur.Reset()
				continue
			}
		}
		cur.WriteByte(ch)
	}
	t.Fatalf("no top-level FROM in query")
	return nil
}
