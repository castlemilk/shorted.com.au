package alertevents

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

// The migration's email_status CHECK and the Statuses constants are the same list
// written twice, once for Postgres and once for Go. This test reads the migration
// that last replaces the CHECK (000148) so that adding a status to one without the
// other fails here.
func TestEmailStatusCheckMatchesConstants(t *testing.T) {
	sql, err := os.ReadFile(filepath.Join("..", "..", "migrations", "000148_add_email_suppression.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	check := regexp.MustCompile(`alert_events_email_status_check CHECK \(email_status IN\s*\(([^)]*)\)\)`).FindSubmatch(sql)
	if check == nil {
		t.Fatal("000148 has no email_status CHECK")
	}
	literal := regexp.MustCompile(`'([a-z_]+)'`)
	var fromSQL []string
	for _, m := range literal.FindAllSubmatch(check[1], -1) {
		fromSQL = append(fromSQL, string(m[1]))
	}
	want := append([]string(nil), Statuses...)
	sort.Strings(fromSQL)
	sort.Strings(want)
	if len(fromSQL) != len(want) {
		t.Fatalf("CHECK admits %v, constants are %v", fromSQL, want)
	}
	for i := range want {
		if fromSQL[i] != want[i] {
			t.Fatalf("CHECK admits %v, constants are %v", fromSQL, want)
		}
	}
}
