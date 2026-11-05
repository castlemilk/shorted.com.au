package backtest

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"
)

func mustD(t *testing.T, s string) civil.Date {
	t.Helper()
	d, err := civil.ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// monthlySessions is every weekday from from to to, as sessions. The derivation
// only needs month-end sessions, and these are the last weekday of each month.
func monthlySessions(t *testing.T, from, to string) []civil.Date {
	t.Helper()
	var out []civil.Date
	for d := mustD(t, from); !d.After(mustD(t, to)); d = d.AddDays(1) {
		wd := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC).Weekday()
		if wd != time.Saturday && wd != time.Sunday {
			out = append(out, d)
		}
	}
	return out
}

func TestAddMonthsClampsToTheMonthEnd(t *testing.T) {
	cases := []struct {
		from string
		n    int
		want string
	}{
		{"2023-12-31", 2, "2024-02-29"},
		{"2023-08-31", 6, "2024-02-29"},
		{"2024-06-30", 12, "2025-06-30"},
		{"2024-01-31", 1, "2024-02-29"},
		{"2024-12-15", 2, "2025-02-15"},
		{"2024-03-31", -12, "2023-03-31"},
	}
	for _, c := range cases {
		if got := addMonthsClamped(mustD(t, c.from), c.n); got.String() != c.want {
			t.Errorf("addMonthsClamped(%s, %d) = %s, want %s", c.from, c.n, got, c.want)
		}
	}
}

func TestKnownAtNeedsTwoMonthsAndOneSession(t *testing.T) {
	// A 31 December result is known from the session after 29 February: a
	// 29 February session is too early, the next session is the first.
	p := Statement{PeriodEnd: mustD(t, "2023-12-31"), Span: 12, Flow: true}
	if knownAt(p, mustD(t, "2024-02-29")) {
		t.Error("known on 2024-02-29, the two-month mark itself")
	}
	if !knownAt(p, mustD(t, "2024-03-01")) {
		t.Error("not known on 2024-03-01, the first session after the two-month mark")
	}
}

func TestMonthEndsPicksTheLastSessionOfEachMonth(t *testing.T) {
	sessions := monthlySessions(t, "2024-01-01", "2024-03-29")
	ends := MonthEnds(sessions)
	want := []string{"2024-01-31", "2024-02-29", "2024-03-29"}
	if len(ends) != len(want) {
		t.Fatalf("got %d month ends, want %d: %v", len(ends), len(want), ends)
	}
	for i, w := range want {
		if ends[i].String() != w {
			t.Errorf("month end %d = %s, want %s", i, ends[i], w)
		}
	}
}

// annualUniverse gives n codes an annual pair (FY prior and FY current) and a
// balance snapshot, with a 31 December 2023 result for the first `withCurrent`.
func annualUniverse(t *testing.T, n, withCurrent int) map[string][]Statement {
	t.Helper()
	out := map[string][]Statement{}
	for i := 0; i < n; i++ {
		code := string(rune('A' + i))
		stmts := []Statement{
			{PeriodEnd: mustD(t, "2022-12-31"), Span: 12, Flow: true},
			{PeriodEnd: mustD(t, "2022-12-31"), Span: 3, Balance: true},
		}
		if i < withCurrent {
			stmts = append(stmts,
				Statement{PeriodEnd: mustD(t, "2023-12-31"), Span: 12, Flow: true},
				Statement{PeriodEnd: mustD(t, "2023-12-31"), Span: 3, Balance: true},
			)
		}
		out[code] = stmts
	}
	return out
}

func TestDeriveComputableFromReadsTheBringingYear(t *testing.T) {
	sessions := monthlySessions(t, "2023-01-02", "2024-12-31")
	// Four codes; the two with a 31 Dec 2023 result are half the universe, so
	// the threshold is met as soon as their result is known (after 29 Feb 2024).
	got, err := DeriveComputableFrom(annualUniverse(t, 4, 2), Needs{Growth: true}, sessions)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found {
		t.Fatalf("not found; share %.2f", got.Share)
	}
	// A result is known from the first session after 29 February 2024, so the
	// first month end that sees it is the last weekday of March.
	if got.ComputableFrom.String() != "2024-03-29" {
		t.Errorf("computable_from = %s, want 2024-03-29", got.ComputableFrom)
	}
	if got.FiscalLabel != "FY2023" {
		t.Errorf("fiscal label = %q, want FY2023 for a 31 December 2023 result", got.FiscalLabel)
	}
}

func TestDeriveComputableFromNotFoundReportsTheShare(t *testing.T) {
	sessions := monthlySessions(t, "2023-01-02", "2024-12-31")
	got, err := DeriveComputableFrom(annualUniverse(t, 4, 1), Needs{Growth: true}, sessions)
	if err != nil {
		t.Fatal(err)
	}
	if got.Found {
		t.Fatalf("found at %s with one code of four computable; the threshold is one half", got.ComputableFrom)
	}
	if got.FiscalLabel != "" {
		t.Errorf("label %q set without a computable_from", got.FiscalLabel)
	}
	if got.Share != 0.25 {
		t.Errorf("share = %v, want 0.25 (one of four at its best)", got.Share)
	}
}

func TestDeriveComputableFromQualityNeedsFlowAndBalance(t *testing.T) {
	sessions := monthlySessions(t, "2024-01-01", "2024-12-31")
	stmts := map[string][]Statement{
		// A flow period with no balance snapshot is not computable for quality.
		"A": {{PeriodEnd: mustD(t, "2023-06-30"), Span: 12, Flow: true}},
		// A snapshot up to six months before the flow period counts.
		"B": {
			{PeriodEnd: mustD(t, "2023-06-30"), Span: 12, Flow: true},
			{PeriodEnd: mustD(t, "2023-03-31"), Span: 3, Balance: true},
		},
	}
	got, err := DeriveComputableFrom(stmts, Needs{Quality: true}, sessions)
	if err != nil {
		t.Fatal(err)
	}
	// B is computable from the first month end on which its flow row is known:
	// 31 August 2023 plus two months, so from September; sessions open in 2024,
	// and the first month end of the window is 31 January 2024.
	if !got.Found || got.ComputableFrom.String() != "2024-01-31" {
		t.Errorf("computable_from = %s found %t, want 2024-01-31", got.ComputableFrom, got.Found)
	}
	if got.Share != 0.5 {
		t.Errorf("share = %v, want 0.5 (B only)", got.Share)
	}
}

func TestDeriveComputableFromNeedsARule(t *testing.T) {
	if _, err := DeriveComputableFrom(annualUniverse(t, 2, 2), Needs{}, nil); err == nil {
		t.Fatal("no fundamentals rule must be refused, not read as computable")
	}
}
