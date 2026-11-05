package backtest

import (
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
)

// The strict computable_from derivation. A fundamentals strategy's
// window opens at the first month-end session on which at least half of its
// universe is computable from the fundamentals stored by that session. Nothing
// here is typed in: the job derives the date from stock_fundamentals on every
// publish, and the fiscal label is the fiscal year of the period that brought
// the median code over the line.

// ComputableShare is the share of the universe the derivation must reach on a
// month-end session before the window may open.
const ComputableShare = 0.5

// Statement is one stored statement period of a code, as the derivation reads
// it. Span is the period's length in months: 12 for an annual (or ttm) period,
// 6 for a half, 3 for a quarter balance snapshot.
type Statement struct {
	PeriodEnd civil.Date
	Span      int
	// Flow is an income-statement period (annual, half or ttm). Balance is a
	// balance snapshot (a quarter row, which carries no flow fields).
	Flow    bool
	Balance bool
}

// Needs names the fundamentals a strategy's rules read. A strategy that reads
// growth needs a like-span pair of flow periods; one that reads quality needs a
// flow period and a balance snapshot.
type Needs struct {
	Growth  bool
	Quality bool
}

// Derivation is the outcome of the strict derivation over a window's sessions.
type Derivation struct {
	// ComputableFrom is the first month-end session at which the universe share
	// reaches ComputableShare. Found is false when it never does.
	ComputableFrom civil.Date
	Found          bool
	// FiscalLabel is "FY" and the calendar year the bringing period ends in,
	// for the median computable code at ComputableFrom. Empty when not found.
	FiscalLabel string
	// Share is the highest universe share reached on any month-end session, so
	// a not-computable outcome can print the measured share.
	Share float64
}

// addMonthsClamped adds n calendar months to d, clamping the day to the month's
// last day (31 December plus two months is the last day of February).
func addMonthsClamped(d civil.Date, n int) civil.Date {
	total := d.Year*12 + int(d.Month) - 1 + n
	year, month := total/12, time.Month(total%12+1)
	firstNext := civil.Date{Year: year, Month: month + 1, Day: 1}
	if month == time.December {
		firstNext = civil.Date{Year: year + 1, Month: time.January, Day: 1}
	}
	lastDay := firstNext.AddDays(-1).Day
	return civil.Date{Year: year, Month: month, Day: min(d.Day, lastDay)}
}

// knownAt reports whether a statement is known on session m: its period end plus
// two calendar months plus one session is on or before m. For a session m that
// is the same as m falling after the period end plus two calendar months, since
// m is itself a session and the first session after that date is no later.
func knownAt(p Statement, m civil.Date) bool {
	return m.After(addMonthsClamped(p.PeriodEnd, 2))
}

// growthComputable reports a like-span pair of flow periods, both known on m.
// An annual pair is one year apart and a half pair six months apart.
func growthComputable(stmts []Statement, m civil.Date) bool {
	for _, cur := range stmts {
		if !cur.Flow || !knownAt(cur, m) || (cur.Span != 12 && cur.Span != 6) {
			continue
		}
		for _, prior := range stmts {
			if !prior.Flow || prior.Span != cur.Span || !knownAt(prior, m) {
				continue
			}
			if sameMonthAfter(prior.PeriodEnd, cur.Span, cur.PeriodEnd) {
				return true
			}
		}
	}
	return false
}

// sameMonthAfter reports whether addMonthsClamped(from, span) is the month of to.
func sameMonthAfter(from civil.Date, span int, to civil.Date) bool {
	next := addMonthsClamped(from, span)
	return next.Year == to.Year && next.Month == to.Month
}

// qualityComputable reports a flow period and a balance snapshot, both known on
// m, where the snapshot is at or up to six months before the flow period's end.
func qualityComputable(stmts []Statement, m civil.Date) bool {
	for _, f := range stmts {
		if !f.Flow || !knownAt(f, m) {
			continue
		}
		for _, b := range stmts {
			if !b.Balance || !knownAt(b, m) {
				continue
			}
			if !b.PeriodEnd.After(f.PeriodEnd) && !f.PeriodEnd.After(addMonthsClamped(b.PeriodEnd, 6)) {
				return true
			}
		}
	}
	return false
}

// computableAt reports whether one code's stored statements support the needs on m.
func computableAt(stmts []Statement, need Needs, m civil.Date) bool {
	if !need.Growth && !need.Quality {
		return false
	}
	if need.Growth && !growthComputable(stmts, m) {
		return false
	}
	if need.Quality && !qualityComputable(stmts, m) {
		return false
	}
	return true
}

// bringingPeriod is the newest period end among a code's statements known on m:
// the period the code's latest figures come from.
func bringingPeriod(stmts []Statement, m civil.Date) (civil.Date, bool) {
	var best civil.Date
	found := false
	for _, s := range stmts {
		if !knownAt(s, m) {
			continue
		}
		if !found || best.Before(s.PeriodEnd) {
			best = s.PeriodEnd
			found = true
		}
	}
	return best, found
}

// MonthEnds returns the last session of each calendar month in sessions, in order.
// sessions must be ascending.
func MonthEnds(sessions []civil.Date) []civil.Date {
	var out []civil.Date
	for i, s := range sessions {
		if i+1 == len(sessions) || sessions[i+1].Month != s.Month || sessions[i+1].Year != s.Year {
			out = append(out, s)
		}
	}
	return out
}

// DeriveComputableFrom runs the strict derivation. statements maps each universe
// code to its stored statement periods; sessions are the window's sessions,
// ascending. The universe is every key of statements. It is a function of its
// inputs: codes are visited in sorted order.
func DeriveComputableFrom(statements map[string][]Statement, need Needs, sessions []civil.Date) (Derivation, error) {
	if !need.Growth && !need.Quality {
		return Derivation{}, fmt.Errorf("backtest: computable_from needs a fundamentals rule")
	}
	if len(statements) == 0 {
		return Derivation{}, nil
	}
	codes := make([]string, 0, len(statements))
	for code := range statements {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	var out Derivation
	for _, m := range MonthEnds(sessions) {
		var ok []string
		for _, code := range codes {
			if computableAt(statements[code], need, m) {
				ok = append(ok, code)
			}
		}
		share := float64(len(ok)) / float64(len(codes))
		if share > out.Share {
			out.Share = share
		}
		if share < ComputableShare {
			continue
		}
		out.ComputableFrom = m
		out.Found = true
		out.FiscalLabel = medianLabel(statements, ok, m)
		return out, nil
	}
	return out, nil
}

// medianLabel is "FY" and the year of the median bringing period among the
// computable codes. The lower median is taken on an even count.
func medianLabel(statements map[string][]Statement, codes []string, m civil.Date) string {
	var periods []civil.Date
	for _, code := range codes {
		if p, ok := bringingPeriod(statements[code], m); ok {
			periods = append(periods, p)
		}
	}
	if len(periods) == 0 {
		return ""
	}
	sort.Slice(periods, func(i, j int) bool { return periods[i].Before(periods[j]) })
	median := periods[(len(periods)-1)/2]
	return fmt.Sprintf("FY%d", median.Year)
}
