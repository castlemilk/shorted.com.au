package ingest

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
)

// env returns a getenv over a map, so config tests never touch the process env.
func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func nanValue() float64 { return math.NaN() }

func TestConfig_DisabledByDefaultAndMountsNothing(t *testing.T) {
	cfg, problem := ConfigFromEnv(env(nil))
	if cfg.Enabled || problem != "" {
		t.Fatalf("the ingest is off by default, got enabled=%v problem=%q", cfg.Enabled, problem)
	}
}

func TestConfig_EnabledWithAllRequiredIsUsable(t *testing.T) {
	cfg, problem := ConfigFromEnv(env(map[string]string{
		EnvEnabled:       "true",
		EnvOrg:           "org-shorted",
		EnvAllowSubjects: "rig:a, rig:b",
		EnvDenyKIDs:      "old-kid",
	}))
	if problem != "" {
		t.Fatalf("a complete config has no problem, got %q", problem)
	}
	if !cfg.Enabled || cfg.Issuer != DefaultIssuer || cfg.Audience != DefaultAudience {
		t.Errorf("defaults for issuer and audience, got %+v", cfg)
	}
	if len(cfg.AllowSubjects) != 2 || cfg.AllowSubjects[1] != "rig:b" {
		t.Errorf("allow list entries are trimmed, got %q", cfg.AllowSubjects)
	}
	if cfg.MinContractVersion != DefaultMinContractVersion || cfg.PriceFraction != DefaultPriceFraction {
		t.Errorf("defaults for the contract and quarantine, got %+v", cfg)
	}
}

// TestConfig_EnabledWithMissingRequiredIsAProblem: enabled without org or subjects is
// reported. The service is still mounted, and it refuses calls. See ConfigFromEnv.
func TestConfig_EnabledWithMissingRequiredIsAProblem(t *testing.T) {
	cases := map[string]map[string]string{
		"no org":           {EnvEnabled: "true", EnvAllowSubjects: "rig:a"},
		"no subjects":      {EnvEnabled: "true", EnvOrg: "org-shorted"},
		"bad contract":     {EnvEnabled: "true", EnvOrg: "o", EnvAllowSubjects: "rig:a", EnvMinContractVersion: "0"},
		"bad price frac":   {EnvEnabled: "true", EnvOrg: "o", EnvAllowSubjects: "rig:a", EnvQuarantinePriceFraction: "1.5"},
		"bad delist floor": {EnvEnabled: "true", EnvOrg: "o", EnvAllowSubjects: "rig:a", EnvQuarantineDelistFloor: "-1"},
	}
	for name, m := range cases {
		t.Run(name, func(t *testing.T) {
			cfg, problem := ConfigFromEnv(env(m))
			if problem == "" {
				t.Fatalf("want a config problem, got none (%+v)", cfg)
			}
			if !cfg.Enabled {
				t.Errorf("an enabled config with a problem stays mounted (to refuse), got enabled=false")
			}
		})
	}
}

// TestConfig_UnparseableEnableFlagIsNotMounted: a typo in HOUSING_INGEST_ENABLED is
// reported and the ingest stays unmounted, never half-enabled.
func TestConfig_UnparseableEnableFlagIsNotMounted(t *testing.T) {
	cfg, problem := ConfigFromEnv(env(map[string]string{EnvEnabled: "ture"}))
	if cfg.Enabled || problem == "" {
		t.Fatalf("a bad flag is reported and not mounted, got enabled=%v problem=%q", cfg.Enabled, problem)
	}
}

func TestValidate_KeyMustBeJobAttemptSource(t *testing.T) {
	ok := sweepReq("job-1", 2, pb.Source_SOURCE_DOMAIN, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	if err := validateEnvelope(ok, 1); err != nil {
		t.Fatalf("a well-formed key validates: %v", err)
	}
	for name, mutate := range map[string]func(*pb.PushSweepRequest){
		"wrong attempt": func(r *pb.PushSweepRequest) { r.IdempotencyKey = "job-1:3:domain" },
		"wrong source":  func(r *pb.PushSweepRequest) { r.IdempotencyKey = "job-1:2:rea" },
		"wrong job":     func(r *pb.PushSweepRequest) { r.IdempotencyKey = "job-2:2:domain" },
		"empty":         func(r *pb.PushSweepRequest) { r.IdempotencyKey = "" },
		"extra segment": func(r *pb.PushSweepRequest) { r.IdempotencyKey = "job-1:2:domain:x" },
	} {
		t.Run(name, func(t *testing.T) {
			req := sweepReq("job-1", 2, pb.Source_SOURCE_DOMAIN, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
			mutate(req)
			if err := validateEnvelope(req, 1); !errIsInvalid(err) {
				t.Errorf("want InvalidArgument, got %v", err)
			}
		})
	}
}

func TestValidate_EnumsAndNumbers(t *testing.T) {
	bad := map[string]func(*pb.PushSweepRequest){
		"unspecified source":     func(r *pb.PushSweepRequest) { r.Source = pb.Source_SOURCE_UNSPECIFIED },
		"unspecified status":     func(r *pb.PushSweepRequest) { r.Status = pb.SweepStatus_SWEEP_STATUS_UNSPECIFIED },
		"unknown listing kind":   func(r *pb.PushSweepRequest) { r.Listings[0].PriceKind = "guess" },
		"unknown listing status": func(r *pb.PushSweepRequest) { r.Listings[0].Status = "maybe" },
		"NaN price": func(r *pb.PushSweepRequest) {
			v := nanValue()
			r.Listings[0].PriceLow = &v
		},
		"negative price": func(r *pb.PushSweepRequest) {
			v := -1.0
			r.Listings[0].PriceLow = &v
		},
		"latitude out of range": func(r *pb.PushSweepRequest) {
			v := 91.0
			r.Listings[0].Lat = &v
		},
		"bedrooms out of range": func(r *pb.PushSweepRequest) {
			v := int32(500)
			r.Listings[0].Bedrooms = &v
		},
		"pages over cap":            func(r *pb.PushSweepRequest) { r.Pages = MaxPagesPerSweep + 1 },
		"listing from other source": func(r *pb.PushSweepRequest) { r.Listings[0].Source = "domain" },
		"missing listing id":        func(r *pb.PushSweepRequest) { r.Listings[0].ListingId = "" },
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
			mutate(req)
			if err := validateEnvelope(req, 1); !errIsInvalid(err) {
				t.Errorf("want InvalidArgument, got %v", err)
			}
		})
	}
}

// TestValidate_FieldCaps pins the byte caps on every string field a listing carries.
func TestValidate_FieldCaps(t *testing.T) {
	caps := map[string]struct {
		max int
		set func(*pb.Listing, string)
	}{
		"listing_url":   {maxURLBytes, func(l *pb.Listing, v string) { l.ListingUrl = v }},
		"display_addr":  {maxAddressBytes, func(l *pb.Listing, v string) { l.DisplayAddr = v }},
		"listing_id":    {maxListingIDBytes, func(l *pb.Listing, v string) { l.ListingId = v }},
		"suburb":        {maxSuburbBytes, func(l *pb.Listing, v string) { l.Suburb = v }},
		"property_type": {maxPropertyBytes, func(l *pb.Listing, v string) { l.PropertyType = v }},
		"agency_name":   {maxAgencyNameBytes, func(l *pb.Listing, v string) { l.AgencyName = v }},
		"agent name":    {maxAgentNameBytes, func(l *pb.Listing, v string) { l.AgentNames = []string{v} }},
	}
	for name, c := range caps {
		t.Run(name, func(t *testing.T) {
			ok := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
			c.set(ok.Listings[0], strings.Repeat("x", c.max))
			if err := validateEnvelope(ok, 1); err != nil {
				t.Fatalf("a value at the cap is valid: %v", err)
			}
			over := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
			c.set(over.Listings[0], strings.Repeat("x", c.max+1))
			if err := validateEnvelope(over, 1); !errIsInvalid(err) {
				t.Errorf("one byte over the cap is InvalidArgument, got %v", err)
			}
		})
	}
}

func TestValidate_ContractFloorIsFailedPrecondition(t *testing.T) {
	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	req.ContractVersion = 1
	err := validateEnvelope(req, 2)
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "contract_too_old") {
		t.Fatalf("a collector below the floor is FailedPrecondition contract_too_old, got %v", err)
	}
}

func TestValidate_ListingCountIsCapped(t *testing.T) {
	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	for i := 0; i <= MaxListingsPerSweep; i++ {
		req.Listings = append(req.Listings, fixedRea(fmt.Sprintf("L%d", i), 1_000_000))
	}
	if err := validateEnvelope(req, 1); !errIsInvalid(err) {
		t.Fatalf("2001 listings is InvalidArgument, got %v", err)
	}
}

// TestCycle_OutcomeAndCountsAreBounded keeps the cycle record to its vocabulary.
func TestCycle_OutcomeAndCountsAreBounded(t *testing.T) {
	ok := &pb.ReportCycleRequest{CycleId: "c-1", Outcome: "ok", ExitCode: 0}
	if err := validateCycle(ok); err != nil {
		t.Fatalf("a valid cycle validates: %v", err)
	}
	for name, req := range map[string]*pb.ReportCycleRequest{
		"unknown outcome": {CycleId: "c-1", Outcome: "happy"},
		"exit too high":   {CycleId: "c-1", Outcome: "ok", ExitCode: 256},
		"empty id":        {CycleId: "", Outcome: "ok"},
		"negative count":  {CycleId: "c-1", Outcome: "ok", Counts: &pb.CycleCounts{ListingsTouched: -1}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateCycle(req); !errIsInvalid(err) {
				t.Errorf("want InvalidArgument, got %v", err)
			}
		})
	}
}

// TestCycleStatus_MapsOntoTheTableVocabulary: crawl_run_status's CHECK allows ok,
// blocked, rewarm, partial and error. Every outcome lands on one of them.
func TestCycleStatus_MapsOntoTheTableVocabulary(t *testing.T) {
	allowed := map[string]bool{"ok": true, "blocked": true, "rewarm": true, "partial": true, "error": true}
	for outcome := range validCycleOutcome {
		if got := cycleStatus(outcome); !allowed[got] {
			t.Errorf("outcome %q maps to %q, which crawl_run_status does not allow", outcome, got)
		}
	}
}

// TestResponses_CarryNoListingData: no response type has a field for a listing. The
// check reads the descriptors, so a field added later is caught here.
func TestResponses_CarryNoListingData(t *testing.T) {
	forbidden := map[string]bool{
		"address": true, "address_key": true, "listing_url": true, "display_addr": true,
		"display_address": true, "listing_id": true, "listings": true, "agent_names": true,
		"agency_name": true, "price_low": true, "price_high": true, "suburb": true,
		"lat": true, "lng": true, "url": true,
	}
	for _, msg := range []protoreflect.MessageDescriptor{
		(&pb.PushSweepResponse{}).ProtoReflect().Descriptor(),
		(&pb.ProbeAuthResponse{}).ProtoReflect().Descriptor(),
		(&pb.ReportCycleResponse{}).ProtoReflect().Descriptor(),
	} {
		fields := msg.Fields()
		for i := 0; i < fields.Len(); i++ {
			if name := string(fields.Get(i).Name()); forbidden[name] {
				t.Errorf("%s has a listing-data field %q", msg.FullName(), name)
			}
		}
	}

	// A populated response, marshalled, has no such key either.
	resp := &pb.PushSweepResponse{AppliedStatus: pb.SweepStatus_SWEEP_STATUS_COMPLETE, Events: 3, ListingsUpserted: 2}
	b, err := protojson.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for k := range m {
		if forbidden[k] {
			t.Errorf("a marshalled PushSweepResponse carries %q", k)
		}
	}
}

// TestIngestIsNotPublic: the ingest service is in no public surface. Its package is
// not shorts.v1alpha1, so the OpenAPI generator, the MCP catalog and the legacy
// ShortedStocksService never see it, and no method carries VISIBILITY_PUBLIC.
func TestIngestIsNotPublic(t *testing.T) {
	public := protovisibility.PublicMethodNames()
	paths := protovisibility.PublicMethodPaths()
	for name := range public {
		if strings.Contains(name, "housingingest") || strings.Contains(name, "CrawlIngest") {
			t.Errorf("the ingest method %s is public", name)
		}
	}
	for path := range paths {
		if strings.Contains(path, "CrawlIngest") {
			t.Errorf("the ingest path %s is in the public set", path)
		}
	}

	// The OpenAPI generator names its services explicitly. The ingest is not one.
	buf, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "proto", "buf.gen.yaml"))
	if err != nil {
		t.Fatalf("read buf.gen.yaml: %v", err)
	}
	if strings.Contains(string(buf), "housingingest") || strings.Contains(string(buf), "CrawlIngest") {
		t.Error("buf.gen.yaml names the ingest service, so it would reach the public OpenAPI output")
	}
}

// TestRateLimiter_PrunesAndCaps: the window is sliding, and an idle rig's history is
// dropped rather than kept forever.
func TestRateLimiter_PrunesAndCaps(t *testing.T) {
	clock := newTestClock()
	l := newPushLimiter(3, time.Hour, clock.Now)
	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("rig:a"); !ok {
			t.Fatalf("push %d of 3 must pass", i+1)
		}
	}
	ok, retry := l.allow("rig:a")
	if ok || retry <= 0 || retry > time.Hour {
		t.Fatalf("the 4th inside the hour is refused with a retry, got ok=%v retry=%v", ok, retry)
	}
	if ok, _ := l.allow("rig:b"); !ok {
		t.Error("the limit is per rig, so another rig is unaffected")
	}
	clock.Advance(time.Hour + time.Second)
	if ok, _ := l.allow("rig:a"); !ok {
		t.Error("after the window the rig may push again")
	}
}

func TestBearerToken(t *testing.T) {
	for in, want := range map[string]string{
		"Bearer abc.def.ghi": "abc.def.ghi",
		"bearer abc":         "abc",
		"Basic abc":          "",
		"Bearer ":            "",
		"":                   "",
	} {
		if got := bearerToken(in); got != want {
			t.Errorf("bearerToken(%q) = %q, want %q", in, got, want)
		}
	}
}
