package shorts

import (
	"strings"
	"testing"
)

// The one-member summary differs from the hub list's only in how it counts the
// member's 90-day changes, and both count the same two event kinds.
func TestPoliticianSummarySelectOne_CountsOneMembersChangesTheSameWay(t *testing.T) {
	if !strings.Contains(politicianSummarySelect, changes90dGroupedJoin) {
		t.Fatal("the hub list must keep the grouped changes pass")
	}
	if !strings.Contains(politicianSummarySelectOne, changes90dOneJoin) {
		t.Fatal("the one-member read must count the member's own changes")
	}
	if strings.Contains(politicianSummarySelectOne, "GROUP BY politician_id") {
		t.Error("the one-member read must not aggregate every member's holdings")
	}
	if got := strings.Replace(politicianSummarySelectOne, changes90dOneJoin, changes90dGroupedJoin, 1); got != politicianSummarySelect {
		t.Error("the two summary selects must differ only in the changes join")
	}
	// The same two predicates as changes90dCount, each its own count, so a
	// holding with a recent start AND a recent end still counts twice.
	for _, predicate := range []string{
		"declared_from_known AND declared_from >= CURRENT_DATE - 90",
		"declared_to IS NOT NULL AND declared_to >= CURRENT_DATE - 90",
	} {
		if !strings.Contains(changes90dCount, predicate) {
			t.Fatalf("changes90dCount no longer uses %q: change changes90dOneJoin to match", predicate)
		}
		if !strings.Contains(changes90dOneJoin, "count(*) FILTER (WHERE "+predicate+")") {
			t.Errorf("changes90dOneJoin must count %q on its own", predicate)
		}
	}
	if !strings.Contains(changes90dOneJoin, "WHERE politician_id = p.id") {
		t.Error("the one-member count must read only that member's entries")
	}
}
