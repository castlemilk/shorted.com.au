package influence

// The parliament → date map, and the interval arithmetic that needs it.
//
// WHY THIS EXISTS. The Handbook publishes a senator's service as DATED
// INTERVALS (`PartyParliamentaryService`) and a member's as dated ELECTORATE
// intervals (`ElectorateService`), but it publishes `RepresentedParliaments` as
// a single flat list across BOTH chambers. For the 14 people who served in both
// houses, that list cannot say which parliaments were Senate ones. The only way
// to tell them apart is to subtract the dated House intervals from the dated
// service intervals and map what is left back onto parliaments — which needs a
// parliament→date map, and there is no endpoint that publishes one.
//
// THE DATES ARE ELECTION DAYS, and they are not a guess. Every one below was
// cross-checked against the Handbook's own ElectorateService boundaries in the
// live payload: 150 House records start exactly on 2016-07-02, 151 on
// 2019-05-18, 151 on 2022-05-21 and 149 on 2025-05-03. The Handbook models a
// House term as [election day of this parliament, election day of the next), so
// using the same boundaries makes the subtraction exact rather than approximate.
//
// A parliament's span therefore runs from its election day to the NEXT
// parliament's election day. That deliberately includes the caretaker gap: a
// senator's term runs to 30 June regardless of when the House was dissolved, so
// a senator legitimately sits in the first weeks of a new parliament, and the
// half-open span is what makes that fall out correctly instead of needing a
// special case.

import "time"

// parliamentElectionDates maps a parliament number to the election that
// returned it. 38 is the earliest the register corpus can reach back to via a
// dual-chamber career; 48 is current.
//
// Hand-verified, one line at a time:
//
//	38  2 March 1996        41   9 October 2004     44   7 September 2013
//	39  3 October 1998      42  24 November 2007    45   2 July 2016
//	40 10 November 2001     43  21 August 2010      46  18 May 2019
//	                                                47  21 May 2022
//	                                                48   3 May 2025
var parliamentElectionDates = map[int]string{
	38: "1996-03-02",
	39: "1998-10-03",
	40: "2001-11-10",
	41: "2004-10-09",
	42: "2007-11-24",
	43: "2010-08-21",
	44: "2013-09-07",
	45: "2016-07-02",
	46: "2019-05-18",
	47: "2022-05-21",
	48: "2025-05-03",
}

// firstMappedParliament / lastMappedParliament bound the map above.
const (
	firstMappedParliament = 38
	lastMappedParliament  = 48
)

// minSenateParliament is the earliest parliament a Senate term may be written
// for. The register corpus starts at 44, and a term for a parliament no
// declared interest can belong to would add a chamber label to a profile with
// nothing behind it. Deliberately the same floor the register itself has.
const minSenateParliament = 44

// dateOpen is the sentinel for "still running". It is far enough out that no
// real interval reaches it and it sorts last in any comparison.
var dateOpen = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)

// handbookOngoingDate is what the Handbook writes for an interval that has not
// ended: NOT an empty string, and NOT a null — the literal 1900-01-01, which is
// BEFORE every real date in the corpus. Parsed naively it turns a sitting
// member's current term into one that ended 126 years ago, and every interval
// comparison built on it silently inverts. It is only ever an END.
const handbookOngoingDate = "1900-01-01"

// dateInterval is a half-open [From, To) span.
type dateInterval struct {
	From time.Time
	To   time.Time
}

// parseHandbookDate reads one Handbook date. ok is false for anything that
// cannot be read as a real date, INCLUDING the 1900-01-01 ongoing marker —
// callers decide what an unreadable bound means for them rather than being
// handed a plausible-looking wrong one.
func parseHandbookDate(s string) (time.Time, bool) {
	if s == "" || s == handbookOngoingDate {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// handbookInterval builds a span from a Handbook start/end pair.
//
// An unreadable START withholds the whole interval: an interval that begins we
// know not when cannot be subtracted from or mapped onto anything, and guessing
// a start is how a Senate term gets attributed to the wrong parliament. An
// unreadable END is the ongoing case and becomes dateOpen.
func handbookInterval(start, end string) (dateInterval, bool) {
	from, ok := parseHandbookDate(start)
	if !ok {
		return dateInterval{}, false
	}
	to, ok := parseHandbookDate(end)
	if !ok {
		to = dateOpen
	}
	if !to.After(from) {
		return dateInterval{}, false
	}
	return dateInterval{From: from, To: to}, true
}

// parliamentSpan returns the half-open [election day, next election day) span
// of one parliament. The most recent parliament has no next election, so its
// span is open-ended.
func parliamentSpan(parliament int) (dateInterval, bool) {
	start, ok := parliamentElectionDates[parliament]
	if !ok {
		return dateInterval{}, false
	}
	from, err := time.Parse("2006-01-02", start)
	if err != nil {
		return dateInterval{}, false
	}
	to := dateOpen
	if next, ok := parliamentElectionDates[parliament+1]; ok {
		if t, err := time.Parse("2006-01-02", next); err == nil {
			to = t
		}
	}
	return dateInterval{From: from, To: to}, true
}

// overlaps reports whether two half-open spans share any day.
func (d dateInterval) overlaps(o dateInterval) bool {
	return d.From.Before(o.To) && o.From.Before(d.To)
}

// intersect returns the shared span, if any.
func (d dateInterval) intersect(o dateInterval) (dateInterval, bool) {
	from, to := d.From, d.To
	if o.From.After(from) {
		from = o.From
	}
	if o.To.Before(to) {
		to = o.To
	}
	if !to.After(from) {
		return dateInterval{}, false
	}
	return dateInterval{From: from, To: to}, true
}

// days is the length of a span, used only to weigh one overlap against another.
func (d dateInterval) days() float64 {
	return d.To.Sub(d.From).Hours() / 24
}

// subtractIntervals removes every cut from one span, returning what survives.
//
// THIS IS THE WHOLE DUAL-CHAMBER DERIVATION. `PartyParliamentaryService` covers
// a person's ENTIRE parliamentary career in both chambers; `ElectorateService`
// covers only the House part of it. Subtracting the second from the first
// leaves exactly the Senate part, dated — which is the fact the flat
// RepresentedParliaments list destroys.
//
// It is a subtraction rather than a "was there a House record for that
// parliament?" test because a person can change chamber MID-parliament (Bronwyn
// Bishop moved from the Senate to Mackellar in March 1994, inside the 37th).
// A per-parliament test would have to pick one chamber for that parliament and
// would be wrong about the other; the subtraction keeps both.
func subtractIntervals(span dateInterval, cuts []dateInterval) []dateInterval {
	out := []dateInterval{span}
	for _, cut := range cuts {
		var next []dateInterval
		for _, cur := range out {
			if !cur.overlaps(cut) {
				next = append(next, cur)
				continue
			}
			if cur.From.Before(cut.From) {
				next = append(next, dateInterval{From: cur.From, To: cut.From})
			}
			if cut.To.Before(cur.To) {
				next = append(next, dateInterval{From: cut.To, To: cur.To})
			}
		}
		out = next
		if len(out) == 0 {
			break
		}
	}
	return out
}

// parliamentsCovered returns every parliament in the map whose span shares a day
// with any of the given intervals.
func parliamentsCovered(intervals []dateInterval) map[int]bool {
	out := map[int]bool{}
	for p := firstMappedParliament; p <= lastMappedParliament; p++ {
		span, ok := parliamentSpan(p)
		if !ok {
			continue
		}
		for _, iv := range intervals {
			if iv.overlaps(span) {
				out[p] = true
				break
			}
		}
	}
	return out
}
