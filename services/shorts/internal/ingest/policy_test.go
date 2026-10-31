package ingest

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// Policy rules that need no database: the off-target gate, the empty-COMPLETE rule on
// the gated set, the quarantine thresholds and their floors, the job id alphabet, the
// digest and the cycle vocabulary.

func timestampAt(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

// testPolicyService is a Service with the production thresholds and no database.
func testPolicyService() *Service {
	return &Service{cfg: Config{
		PriceFraction:      DefaultPriceFraction,
		QuarantineMinMoves: DefaultQuarantineMinMoves,
		DelistFraction:     DefaultDelistFraction,
		DelistCap:          DefaultDelistCap,
		MinDelists:         DefaultMinDelists,
	}}
}

var policyTarget = housingcrawl.Target{Suburb: "testville", Display: "Testville", Postcode: "3000", State: "VIC"}

func raw(suburb, postcode string) housingcrawl.RawListing {
	return housingcrawl.RawListing{Source: "rea", ListingID: suburb + postcode, Suburb: suburb, Postcode: postcode, State: "VIC"}
}

func TestGateSweepPoisonAtThirtyPercentHard(t *testing.T) {
	cases := []struct {
		name     string
		hard     int
		soft     int
		on       int
		poisoned bool
	}{
		{"all on target", 0, 0, 10, false},
		{"exactly 30% hard is not poison", 3, 0, 7, false},
		{"over 30% hard is poison", 4, 0, 6, true},
		{"all off target is poison", 10, 0, 0, true},
		// Same postcode, different suburb: a soft miss. It is neither written nor poison.
		{"soft misses do not count toward poison", 0, 10, 0, false},
		{"soft misses are excluded from the denominator's hard count", 3, 4, 3, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var rows []housingcrawl.RawListing
			for i := 0; i < tc.hard; i++ {
				rows = append(rows, raw("Bondi", "2026"))
			}
			for i := 0; i < tc.soft; i++ {
				rows = append(rows, raw("Otherville", "3000"))
			}
			for i := 0; i < tc.on; i++ {
				rows = append(rows, raw("Testville", "3000"))
			}
			gated, poisoned := gateSweep(rows, policyTarget)
			if gated != tc.on || poisoned != tc.poisoned {
				t.Errorf("gated=%d poisoned=%v, want gated=%d poisoned=%v", gated, poisoned, tc.on, tc.poisoned)
			}
		})
	}
}

// TestEffectiveStatusEmptyRuleUsesTheGatedSet: a COMPLETE sweep with no gated listings
// is PARTIAL unless the portal said zero results. The count is the gated set, so a sweep
// that carried listings which were all rejected cannot take the empty-sweep path.
func TestEffectiveStatusEmptyRuleUsesTheGatedSet(t *testing.T) {
	complete := func(total int32, listings int) *pb.PushSweepRequest {
		req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
		req.PageMeta = &pb.PageMeta{TotalResults: total}
		for i := 0; i < listings; i++ {
			req.Listings = append(req.Listings, fixedRea(fmt.Sprintf("L%d", i), 1))
		}
		return req
	}
	partial := func(total int32, listings int) *pb.PushSweepRequest {
		r := complete(total, listings)
		r.Status = pb.SweepStatus_SWEEP_STATUS_PARTIAL
		return r
	}
	cases := []struct {
		name     string
		req      *pb.PushSweepRequest
		gated    int
		poisoned bool
		want     pb.SweepStatus
	}{
		{"gated COMPLETE stays COMPLETE", complete(2, 2), 2, false, pb.SweepStatus_SWEEP_STATUS_COMPLETE},
		{"gated PARTIAL stays PARTIAL", partial(2, 2), 2, false, pb.SweepStatus_SWEEP_STATUS_PARTIAL},
		{"zero gated COMPLETE with zero results is BLOCKED", complete(0, 0), 0, false, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
		{"zero gated COMPLETE with results is BLOCKED, not PARTIAL", complete(5, 2), 0, false, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
		{"zero gated PARTIAL is BLOCKED, so an empty partial never closes", partial(0, 0), 0, false, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
		{"zero gated COMPLETE of soft misses is BLOCKED", complete(0, 2), 0, false, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
		{"poison is BLOCKED whatever the status", complete(5, 2), 2, true, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := effectiveStatus(tc.req, tc.gated, tc.poisoned); got != tc.want {
				t.Errorf("effectiveStatus = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestQuarantinePriceThreshold: LargeMoves must be more than max(25% of existing, 3).
// On 8 existing the threshold is 3; on 40 it is 10; on 3 it is 3 (the floor).
func TestQuarantinePriceThreshold(t *testing.T) {
	s := testPolicyService()
	cases := []struct {
		name       string
		existing   int
		moves      int
		quarantine bool
	}{
		{"3 of 3 existing moving passes: 3 is not more than the floor of 3", 3, 3, false},
		{"4 of 3 is held", 3, 4, true},
		{"one move on three passes (the freeze case)", 3, 1, false},
		{"3 of 8 passes", 8, 3, false},
		{"4 of 8 is held", 8, 4, true},
		{"10 of 40 passes", 40, 10, false},
		{"11 of 40 is held", 40, 11, true},
		{"zero existing and zero moves passes", 0, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := s.quarantineCheck(housingcrawl.Result{Existing: tc.existing, LargeMoves: tc.moves}, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
			if (q != nil) != tc.quarantine {
				t.Fatalf("quarantined = %v, want %v", q != nil, tc.quarantine)
			}
			if q != nil && q.reason != reasonPriceMoves {
				t.Errorf("reason = %q, want %q", q.reason, reasonPriceMoves)
			}
		})
	}
}

// TestQuarantineDelistThreshold: a sweep is held when its delists exceed
// max(MinDelists=3, min(25% of active, DelistCap=20)). The four active counts in the
// review each sit on a different branch of that formula:
//   - 4 active:   25% is 1, so the minimum of 3 governs. 3 passes, 4 is held.
//   - 12 active:  25% is 3, equal to the minimum. 3 passes, 4 is held.
//   - 80 active:  25% is 20, exactly the cap. 20 passes, 21 is held.
//   - 200 active: 25% is 50, so the cap of 20 governs. 20 passes, 21 is held.
func TestQuarantineDelistThreshold(t *testing.T) {
	s := testPolicyService()
	cases := []struct {
		name       string
		active     int
		delisted   int
		quarantine bool
	}{
		{"active 4: 3 delists pass (the minimum governs)", 4, 3, false},
		{"active 4: 4 delists are held", 4, 4, true},
		{"active 12: 3 delists pass (25% equals the minimum)", 12, 3, false},
		{"active 12: 4 delists are held", 12, 4, true},
		{"active 80: 20 delists pass (25% equals the cap)", 80, 20, false},
		{"active 80: 21 delists are held", 80, 21, true},
		{"active 200: 20 delists pass (the cap governs)", 200, 20, false},
		{"active 200: 21 delists are held", 200, 21, true},
		{"no actives: 4 delists are held", 0, 4, true},
		{"no actives: 3 delists pass", 0, 3, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := s.quarantineCheck(housingcrawl.Result{ActiveBefore: tc.active, Delisted: tc.delisted}, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
			if (q != nil) != tc.quarantine {
				t.Fatalf("quarantined = %v, want %v", q != nil, tc.quarantine)
			}
			if q != nil && q.reason != reasonDelists {
				t.Errorf("reason = %q, want %q", q.reason, reasonDelists)
			}
		})
	}
}

func TestQuarantineStatsCarryTheSweepStatus(t *testing.T) {
	q := testPolicyService().quarantineCheck(housingcrawl.Result{Existing: 8, LargeMoves: 4}, pb.SweepStatus_SWEEP_STATUS_PARTIAL)
	if q == nil || q.stats.Status != pb.SweepStatus_SWEEP_STATUS_PARTIAL.String() {
		t.Fatalf("the stats must record the sweep status, got %+v", q)
	}
}

func TestJobIDAlphabet(t *testing.T) {
	ok := []string{"job-1", "a", "A.b_c:d-e", strings.Repeat("x", maxJobIDBytes)}
	for _, id := range ok {
		if !validJobID(id) {
			t.Errorf("%q must be a valid job id", id)
		}
	}
	bad := []string{"", "has space", "slash/x", "new\nline", "quote\"", "emoji\U0001F600", strings.Repeat("x", maxJobIDBytes+1), "sémi"}
	for _, id := range bad {
		if validJobID(id) {
			t.Errorf("%q must not be a valid job id", id)
		}
	}
}

// TestJobIDRefusedBeforeAnyUse: a malformed job id is rejected by validation, before
// it could reach a log line or a database key.
func TestJobIDRefusedBeforeAnyUse(t *testing.T) {
	req := sweepReq("bad job", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	req.JobId = "bad job"
	req.IdempotencyKey = "bad job:1:rea"
	if err := validateEnvelope(req, 1); !errIsInvalid(err) {
		t.Fatalf("a job id outside the alphabet is InvalidArgument, got %v", err)
	}
}

// TestBodyDigestIgnoresObservedAt: observed_at is informational, so the digest must not
// change when only it changes. Every other field still changes it.
func TestBodyDigestIgnoresObservedAt(t *testing.T) {
	a := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	b := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	a.ObservedAt = timestampAt(time.Date(2026, 10, 27, 1, 0, 0, 0, time.UTC))
	b.ObservedAt = timestampAt(time.Date(2026, 10, 27, 1, 0, 9, 0, time.UTC))
	da, err := bodyDigest(a)
	if err != nil {
		t.Fatal(err)
	}
	db, err := bodyDigest(b)
	if err != nil {
		t.Fatal(err)
	}
	if string(da) != string(db) {
		t.Error("observed_at must not change the digest")
	}
	if a.ObservedAt == nil {
		t.Error("the digest must not mutate the request")
	}

	b.Listings[0].PriceLow = new(float64)
	dc, _ := bodyDigest(b)
	if string(da) == string(dc) {
		t.Error("a change in a listing must change the digest")
	}
}

// TestCycleStatusMapping: every outcome maps onto the table vocabulary, and a routine
// cancellation is not an error.
func TestCycleStatusMapping(t *testing.T) {
	want := map[string]string{
		"ok": "ok", "blocked": "blocked", "partial": "partial", "rewarm": "rewarm",
		"deferred": "partial", "cancelled": "partial", "error": "error", "failed": "error",
	}
	for outcome, status := range want {
		if got := cycleStatus(outcome); got != status {
			t.Errorf("cycleStatus(%q) = %q, want %q", outcome, got, status)
		}
	}
}

// TestQuarantineCountsRecentDelistsOnly: the delist trip judges the recent delists. The
// stale ones (DelistedStale) are exempt only when the sweep covered the region, so
// Upserted must reach half of ActiveBefore. The threshold itself is unchanged. A
// poisoned or truncated sweep is held, whatever its stale count, and StaleAfter 0
// leaves every delist counted (no split reported).
func TestQuarantineCountsRecentDelistsOnly(t *testing.T) {
	s := testPolicyService()
	cases := []struct {
		name        string
		active      int
		upserted    int
		delisted    int
		delistStale int
		quarantine  bool
	}{
		{"Bundoora: 124 active, 90 seen, 43 delists, 41 stale, 2 recent: not held", 124, 90, 43, 41, false},
		{"poison shape: 124 active, 90 seen, 43 delists, none stale: held", 124, 90, 43, 0, true},
		{"mixed: 30 delists, 5 stale, 25 recent is over the 20 cap: held", 124, 100, 30, 5, true},
		{"mixed: 30 delists, 10 stale, 20 recent is exactly the cap: not held", 124, 100, 30, 10, false},
		{"small suburb: 5 delists, 3 stale, 2 recent is under the minimum of 3: not held", 4, 2, 5, 3, false},
		{"no split (StaleAfter 0, DelistedStale 0): 43 delists is held", 124, 90, 43, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := s.quarantineCheck(housingcrawl.Result{
				ActiveBefore:  tc.active,
				Upserted:      tc.upserted,
				Delisted:      tc.delisted,
				DelistedStale: tc.delistStale,
			}, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
			if (q != nil) != tc.quarantine {
				t.Fatalf("quarantined = %v, want %v", q != nil, tc.quarantine)
			}
			if q != nil {
				if q.reason != reasonDelists {
					t.Errorf("reason = %q, want %q", q.reason, reasonDelists)
				}
				if q.stats.WouldDelist != tc.delisted || q.stats.DelistedStale != tc.delistStale {
					t.Errorf("stats must keep both counts, got would_delist=%d delisted_stale=%d", q.stats.WouldDelist, q.stats.DelistedStale)
				}
			}
		})
	}
}

// TestQuarantineMeasuredSweeps: the six holds measured in prod on 2026-10-30/31, with
// DelistedStale reconstructed from property_listings (armed, last_seen_at older than 21
// days before the hold), plus the outage shapes that the coverage rule exists for.
func TestQuarantineMeasuredSweeps(t *testing.T) {
	s := testPolicyService()
	cases := []struct {
		name                              string
		active, upserted, delisted, stale int
		wantHeld                          bool
	}{
		{"Thomastown rea: 26 recent (seen 20 Oct), stays held", 150, 123, 26, 0, true},
		{"Wantirna South domain: all 50 stale", 94, 53, 50, 50, false},
		{"Miranda domain: all 27 stale", 95, 70, 27, 27, false},
		{"Narre Warren domain: all 59 stale", 176, 110, 59, 59, false},
		{"Essendon domain: all 48 stale", 133, 89, 48, 48, false},
		{"Bundoora domain: 41 of 43 stale", 124, 90, 43, 41, false},
		{"outage: page-1 truncation of a dark 120, all stale", 120, 20, 100, 100, true},
		{"outage: page-2 truncation of a dark 120, all stale", 120, 40, 80, 80, true},
		{"residual: half of a dark 120 seen, all stale", 120, 60, 60, 60, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := s.quarantineCheck(housingcrawl.Result{
				ActiveBefore: tc.active, Upserted: tc.upserted, Delisted: tc.delisted, DelistedStale: tc.stale,
			}, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
			if (q != nil) != tc.wantHeld {
				t.Errorf("held = %v, want %v", q != nil, tc.wantHeld)
			}
		})
	}
}

// TestStaleExemptNeedsHalfTheRegionSeen pins the coverage boundary: exactly half is
// covered, one fewer is not. Without coverage the stale delists count in full.
func TestStaleExemptNeedsHalfTheRegionSeen(t *testing.T) {
	cases := []struct {
		name     string
		upserted int
		want     bool
	}{
		{"62 of 124 is exactly half", 62, true},
		{"61 of 124 is under half", 61, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := staleExempt(housingcrawl.Result{ActiveBefore: 124, Upserted: tc.upserted}); got != tc.want {
				t.Errorf("staleExempt = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestRecentDelistsNeverNegative: a stale count can never exceed the delists it came
// from, but the figure is clamped at zero so a bad input cannot read as a credit.
func TestQuarantineRecentDelistsNeverNegative(t *testing.T) {
	r := housingcrawl.Result{ActiveBefore: 10, Upserted: 10, Delisted: 2, DelistedStale: 5}
	if got := recentDelists(r); got != 0 {
		t.Errorf("recentDelists = %d, want 0 (clamped)", got)
	}
}
