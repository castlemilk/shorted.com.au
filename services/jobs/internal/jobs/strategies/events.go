package strategies

import (
	"sort"

	"cloud.google.com/go/civil"
)

// Signal events are the status transitions of a canonical version between two
// sessions. They are diffed from the two sessions' evaluations, both recomputed
// from stored rows, so an event is what the engine said changed, not what a
// previous run remembered.

// transition is one stock's status change under one version.
type transition struct {
	Code  string
	From  string
	To    string
	Score float64 // the score on the session the stock moved to; zero when it left the picks
	Rules pickState
}

// noneStatus is the status of a code that is not a pick on a session.
const noneStatus = "none"

// diffEvaluations returns the transitions from prev to cur, in code order. A
// stock absent from a session's picks is "none". Watch and none moving between
// each other is churn, not a signal, and is not recorded. A nil prev is a
// version's first session: it is a baseline, so it has no transitions.
func diffEvaluations(prev, cur map[string]pickState, prevBaseline bool) []transition {
	if prevBaseline {
		return nil
	}
	codes := make([]string, 0, len(prev)+len(cur))
	seen := map[string]bool{}
	for c := range prev {
		if !seen[c] {
			seen[c] = true
			codes = append(codes, c)
		}
	}
	for c := range cur {
		if !seen[c] {
			seen[c] = true
			codes = append(codes, c)
		}
	}
	sort.Strings(codes)

	var out []transition
	for _, code := range codes {
		from, to := noneStatus, noneStatus
		if p, ok := prev[code]; ok {
			from = p.Status
		}
		c, ok := cur[code]
		if ok {
			to = c.Status
		}
		if from == to || isWatchNoneChurn(from, to) {
			continue
		}
		t := transition{Code: code, From: from, To: to}
		if ok {
			t.Score = c.Score
			t.Rules = c
		}
		out = append(out, t)
	}
	return out
}

// isWatchNoneChurn reports a move between watch and none, in either direction.
func isWatchNoneChurn(a, b string) bool {
	return (a == "watch" && b == noneStatus) || (a == noneStatus && b == "watch")
}

// eventSession names the two sessions an event set was diffed between.
type eventSession struct {
	AsOf     civil.Date
	PrevAsOf civil.Date // zero on a baseline
}
