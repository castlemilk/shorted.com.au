package shorts

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Migration 000088 stores the property.com.au profile under
// source_licence='proprietary-tos-restricted' — a column DEFAULT, so the
// unlicensed state is unstorable — and instructs in the same breath: "MUST
// NEVER be republished raw. Only DERIVED aggregates are a publishable surface
// ... Gate any public read on source_licence."
//
// The read path did not. GetPropertyValuation selected on address_key and
// fetch_status alone, so per-address AVM estimates, rent estimates and sales
// history reached GetPropertyHistory — a VISIBILITY_PUBLIC rpc — for any
// address a caller could name. A column default only means something if the
// read path consults it.
//
// Asserted against the SOURCE on purpose: the store's behavioural tests are
// //go:build integration and need testcontainers, so they do not gate a pull
// request. Losing the predicate would otherwise be invisible until someone
// audited prod again.
//
// TWO TRAPS, both of which made the first version of this file pass while the
// gate was deleted:
//
//  1. The comment explaining the gate sits inside the same SQL literal and says
//     "source_licence" several times, so a substring search over the raw text is
//     satisfied by the prose. SQL comments must be stripped before matching.
//  2. The identical predicate guards the house-price reads elsewhere in this
//     file, so a file-wide regex matches whether or not the VALUATION query has
//     it. The check has to be scoped to the statement under test.
//
// Both tests below are verified to FAIL when the predicate is removed.

var (
	sqlLineComment = regexp.MustCompile(`(?m)--.*$`)
	licenceGate    = regexp.MustCompile(`source_licence\s*<>\s*'proprietary-tos-restricted'`)
)

// valuationQuerySQL returns the SQL literal that reads property_valuations,
// with SQL comments stripped, or fails the test if it cannot be isolated.
func valuationQuerySQL(t *testing.T) string {
	t.Helper()

	src, err := os.ReadFile("postgres_house_prices.go")
	if err != nil {
		t.Fatalf("read store source: %v", err)
	}
	text := string(src)

	const table = "FROM property_valuations"
	idx := strings.Index(text, table)
	if idx == -1 {
		t.Fatalf("no read of %q found — table or file renamed? this guard is now "+
			"vacuous and must be repointed", table)
	}
	if strings.Contains(text[idx+len(table):], table) {
		t.Fatal("more than one read of property_valuations: this guard only checks the " +
			"first and must be widened before a second read is added")
	}

	// The statement runs from the start of its backtick literal to its close.
	open := strings.LastIndex(text[:idx], "`")
	closeAt := strings.Index(text[idx:], "`")
	if open == -1 || closeAt == -1 {
		t.Fatal("could not isolate the SQL literal around the property_valuations read")
	}
	stmt := text[open+1 : idx+closeAt]

	// Strip SQL comments so prose about the gate cannot stand in for the gate.
	return sqlLineComment.ReplaceAllString(stmt, "")
}

func TestPropertyValuationReadIsLicenceGated(t *testing.T) {
	t.Parallel()

	stmt := valuationQuerySQL(t)
	if !licenceGate.MatchString(stmt) {
		t.Errorf("the property_valuations read has no source_licence gate.\n\n"+
			"statement (comments stripped):\n%s\n\n"+
			"migration 000088 requires it — the property.com.au profile is "+
			"proprietary/ToS-restricted and must never be republished raw.",
			strings.TrimSpace(stmt))
	}
}

// Guards the guard: if the comment-stripping ever breaks, the test above would
// start passing on prose alone. This pins that the stripped statement really is
// SQL and really does mention the column in a predicate position.
func TestValuationGateIsFoundInSqlNotInProse(t *testing.T) {
	t.Parallel()

	stmt := valuationQuerySQL(t)
	if strings.Contains(stmt, "--") {
		t.Fatalf("comment stripping failed; the gate check could pass on prose:\n%s", stmt)
	}
	if !strings.Contains(strings.ToUpper(stmt), "WHERE") {
		t.Fatalf("isolated text does not look like a SQL statement:\n%s", stmt)
	}
}
