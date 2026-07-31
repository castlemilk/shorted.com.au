package influence

// Row-level takedown must reach EVERY arm of the fold.
//
// selectHoldingEventsQuery is a three-way UNION ALL — items 1&4, item 3, and
// everything else — because the grain of a "holding" differs by item. A filter
// added to one arm and not the others produces a takedown that works for
// shareholdings and silently fails for a gift, which is worse than no takedown
// at all: the operator is told the row is withdrawn and it is still published.
//
// This is the §8.17 defect class, which this subsystem has already paid for: the
// same fiction was defaulted in three layers, two were fixed, and the API went
// on serving it from the third. A structural assertion is the cheap guard.

import (
	"strings"
	"testing"
)

func TestSuppressionReachesEveryFoldArm(t *testing.T) {
	// One WHERE per arm; if the query is ever restructured, this count is the
	// first thing to re-derive rather than the assertion to relax.
	const wantArms = 3

	arms := strings.Count(selectHoldingEventsQuery, "WHERE ")
	if arms != wantArms {
		t.Fatalf("the fold has %d arms, not %d — re-check that every one filters suppressed rows", arms, wantArms)
	}

	filters := strings.Count(selectHoldingEventsQuery, "i.suppressed_at IS NULL")
	if filters != wantArms {
		t.Errorf("suppressed_at is filtered in %d of %d fold arms; a takedown that misses an arm still publishes the row",
			filters, wantArms)
	}
}

// Suppression HIDES a row; it must never delete one. A deleted declaration is a
// real thing a named person declared, removed from their record — and it also
// breaks the nil-rate tripwire that register_extraction_stats measures ("item 1
// at 100% nil for a whole parliament is a broken parser, not 151 share-free
// members").
func TestFoldNeverDeletesDeclaredItems(t *testing.T) {
	if strings.Contains(strings.ToUpper(selectHoldingEventsQuery), "DELETE") {
		t.Error("the fold query contains a DELETE; takedown is suppression, never deletion")
	}
}
