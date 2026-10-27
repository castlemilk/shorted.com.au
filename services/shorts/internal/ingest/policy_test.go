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
		DelistFloor:        DefaultDelistFloor,
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
	cases := []struct {
		name     string
		req      *pb.PushSweepRequest
		gated    int
		poisoned bool
		want     pb.SweepStatus
	}{
		{"gated sweep stays COMPLETE", complete(2, 2), 2, false, pb.SweepStatus_SWEEP_STATUS_COMPLETE},
		{"zero gated with results is PARTIAL", complete(5, 2), 0, false, pb.SweepStatus_SWEEP_STATUS_PARTIAL},
		{"zero gated and zero results is COMPLETE", complete(0, 0), 0, false, pb.SweepStatus_SWEEP_STATUS_COMPLETE},
		{"zero gated with listings but zero results is COMPLETE", complete(0, 2), 0, false, pb.SweepStatus_SWEEP_STATUS_COMPLETE},
		{"no page metadata is PARTIAL", func() *pb.PushSweepRequest {
			r := complete(0, 0)
			r.PageMeta = nil
			return r
		}(), 0, false, pb.SweepStatus_SWEEP_STATUS_PARTIAL},
		{"poison is BLOCKED whatever the status", complete(5, 2), 0, true, pb.SweepStatus_SWEEP_STATUS_BLOCKED},
		{"PARTIAL stays PARTIAL", func() *pb.PushSweepRequest {
			r := complete(0, 0)
			r.Status = pb.SweepStatus_SWEEP_STATUS_PARTIAL
			return r
		}(), 0, false, pb.SweepStatus_SWEEP_STATUS_PARTIAL},
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

// TestQuarantineDelistThreshold: a delist count must be more than max(25% of the
// active listings before the sweep, 20).
func TestQuarantineDelistThreshold(t *testing.T) {
	s := testPolicyService()
	cases := []struct {
		name       string
		active     int
		delisted   int
		quarantine bool
	}{
		{"20 of 40 active is the 20 floor, passes", 40, 20, false},
		{"21 of 40 active is held", 40, 21, true},
		{"25 of 100 active is exactly 25% (above the floor of 20): passes", 100, 25, false},
		{"26 of 100 active is held", 100, 26, true},
		{"a small suburb delisting all 20 actives is at the floor, passes", 20, 20, false},
		{"no actives: any delist above the floor is held", 0, 21, true},
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
