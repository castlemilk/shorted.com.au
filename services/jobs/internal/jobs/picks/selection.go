package picks

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Selection (plan fundamentals-coverage.md §3.7). Budget-driven: there is no
// count cap by default, the queue is priority-ordered and the run stops taking
// codes when PICKS_FUNDAMENTALS_BUDGET_MIN elapses; what is left carries to
// the next night, lowest priority first.
const (
	// defaultMaxCodes: no count cap (PICKS_FUNDAMENTALS_MAX_CODES, which
	// envPositiveInt ignores at 0). At the 4s pace the ~2,300-code universe
	// is ~155 minutes, inside the 170-minute budget.
	defaultMaxCodes = 0
	// filingLookbackDays: a results filing this recent makes the code due
	// (§3.7: fourteen days).
	filingLookbackDays = 14
	// filingFollowUp: one more pull this long after the filing, for the
	// vendors that lag it (Yahoo lags small caps by days to weeks).
	filingFollowUp = 7 * 24 * time.Hour
	// skipSuccessWithin: a success (or a single empty) this recent is not
	// asked again.
	skipSuccessWithin = 14 * 24 * time.Hour
	// skipRepeatedEmptyWithin: a code that answered empty twice in a row (an
	// ETF, a shell) is asked again only after this long.
	skipRepeatedEmptyWithin = 45 * 24 * time.Hour
	// repeatedEmpty is the consecutive_empty count that earns the long skip.
	repeatedEmpty = 2
)

// syncState is one stock_fundamentals_sync row as selection reads it.
type syncState struct {
	LastAttempt time.Time
	LastSuccess *time.Time
	// LastOutcome is loaded | empty | failed. On a row written before 000132
	// (or a database without it) it is derived from last_error and the two
	// timestamps (deriveOutcome).
	LastOutcome      string
	ConsecutiveEmpty int
	// Legacy: the row predates 000132 in a database that has it
	// (last_outcome IS NULL). The code's stored rows are then the 000129
	// seven-column shape (no full statements, so no quality ratios), and
	// the outcome above is only derived, so selectCodes queues the code like
	// a never-attempted one instead of honouring a derived skip. Always
	// false without 000132, where a re-fetch could not store more anyway.
	Legacy bool
}

// deriveOutcome reads an attempt's outcome off the columns 000129 already
// had, for rows that predate last_outcome: a success sets last_success_at to
// the attempt time; an empty answer was recorded with a
// "no fundamentals published" error (runFundamentals); anything else failed.
func deriveOutcome(lastAttempt time.Time, lastSuccess *time.Time, lastError string) (string, int) {
	switch {
	case lastSuccess != nil && lastSuccess.Equal(lastAttempt):
		return outcomeLoaded, 0
	case strings.HasPrefix(lastError, "no fundamentals published"):
		return outcomeEmpty, 1
	default:
		return outcomeFailed, 0
	}
}

// rankInput orders never-attempted codes: market cap, then 20-day dollar
// volume (either 0 when unknown).
type rankInput struct {
	MarketCap       float64
	DollarVolume20d float64
}

// Selection groups, in order.
const (
	groupDueFiler = iota
	groupNeverAttempted
	groupFailed
	groupStale
	groupCount
)

var groupNames = [groupCount]string{"due_filers", "never_attempted", "failed", "stale"}

// selection is one run's ordered work list.
type selection struct {
	codes   []string
	byGroup [groupCount]int
	skipped int
	// legacy counts the pre-000132 rows queued with the never-attempted
	// group (Legacy), so the rollout's re-fetch shows in the log.
	legacy int
}

func (s selection) summary() string {
	parts := make([]string, 0, groupCount+1)
	for g := 0; g < groupCount; g++ {
		parts = append(parts, fmt.Sprintf("%s=%d", groupNames[g], s.byGroup[g]))
	}
	parts = append(parts, fmt.Sprintf("skipped=%d", s.skipped), fmt.Sprintf("pre_000132=%d", s.legacy))
	return strings.Join(parts, " ")
}

// dueFiler: a results filing (Appendix 4D/4E or a period-results headline) in
// the lookback window that the code has not been pulled since, or its single
// follow-up once the filing is filingFollowUp old.
func dueFiler(filings []time.Time, last *time.Time, now time.Time) bool {
	for _, f := range filings {
		if last == nil || last.Before(f) {
			return true
		}
		follow := f.Add(filingFollowUp)
		if !now.Before(follow) && last.Before(follow) {
			return true
		}
	}
	return false
}

// selectCodes orders one run's work (§3.7) and applies the optional cap:
//
//  1. due filers (dueFiler), never-succeeded first, then oldest attempt;
//  2. never attempted, and codes whose sync row predates 000132 (Legacy: the
//     stored rows lack the full statements, and the outcome is only
//     derived), by market cap descending, then 20-day dollar volume, then
//     code;
//  3. last outcome failed, oldest attempt first (failures are never skipped);
//  4. successes and single empties older than 14 days, and repeated empties
//     older than 45 days, oldest attempt first.
//
// Skipped: a success or single empty within 14 days; an empty with
// consecutive_empty >= 2 within 45 days. A Legacy row is never skipped.
func selectCodes(universe []string, states map[string]syncState, filings map[string][]time.Time,
	ranks map[string]rankInput, now time.Time, maxCodes int) selection {
	type item struct {
		code   string
		group  int
		st     syncState
		rank   rankInput
		legacy bool // queued as never attempted because its row predates 000132
	}
	seen := make(map[string]bool, len(universe))
	var items []item
	var sel selection
	for _, raw := range universe {
		code := normalizeCode(raw)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		st, attempted := states[code]
		it := item{code: code, st: st, rank: ranks[code]}
		switch {
		case dueFiler(filings[code], st.LastSuccess, now):
			it.group = groupDueFiler
		case !attempted:
			it.group = groupNeverAttempted
		case st.Legacy:
			it.group, it.legacy = groupNeverAttempted, true
		case st.LastOutcome == outcomeFailed:
			it.group = groupFailed
		case st.LastOutcome == outcomeEmpty && st.ConsecutiveEmpty >= repeatedEmpty:
			if now.Sub(st.LastAttempt) < skipRepeatedEmptyWithin {
				sel.skipped++
				continue
			}
			it.group = groupStale
		default: // loaded, or a single empty
			if now.Sub(st.LastAttempt) < skipSuccessWithin {
				sel.skipped++
				continue
			}
			it.group = groupStale
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.group != b.group {
			return a.group < b.group
		}
		switch a.group {
		case groupDueFiler:
			if (a.st.LastSuccess == nil) != (b.st.LastSuccess == nil) {
				return a.st.LastSuccess == nil
			}
			if !a.st.LastAttempt.Equal(b.st.LastAttempt) {
				return a.st.LastAttempt.Before(b.st.LastAttempt)
			}
		case groupNeverAttempted:
			if a.rank.MarketCap != b.rank.MarketCap {
				return a.rank.MarketCap > b.rank.MarketCap
			}
			if a.rank.DollarVolume20d != b.rank.DollarVolume20d {
				return a.rank.DollarVolume20d > b.rank.DollarVolume20d
			}
		default:
			if !a.st.LastAttempt.Equal(b.st.LastAttempt) {
				return a.st.LastAttempt.Before(b.st.LastAttempt)
			}
		}
		return a.code < b.code
	})
	if maxCodes > 0 && len(items) > maxCodes {
		items = items[:maxCodes]
	}
	sel.codes = make([]string, len(items))
	for i, it := range items {
		sel.codes[i] = it.code
		sel.byGroup[it.group]++
		if it.legacy {
			sel.legacy++
		}
	}
	return sel
}
