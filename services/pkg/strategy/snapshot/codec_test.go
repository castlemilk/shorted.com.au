package snapshot

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

func fixtureRow() Row {
	d := civil.Date{Year: 2026, Month: 11, Day: 12}
	rep := civil.Date{Year: 2026, Month: 11, Day: 10}
	pos := 1234.0
	pct := 4.2
	return Row{
		AsOf: d, BarDate: d, FeatureSet: "fs1", StockCode: "AAA",
		OrdinaryFresh60: true, IsOrdinary: true, InASICReport: true,
		ShortReportDate: &rep, ShortStatus: "reported",
		Features: Features{
			Bar:   Bar{O: 1, H: 2, L: 0.5, C: 1.5, Adj: 1.5, V: 1000},
			ExDiv: 0.5,
			FS1:   features.PriceFeatures{AsOf: d, Close: 1.5, Volume: 1000, SessionsAvailable: 300},
			SF0:   features.ShortReading{Status: "reported", ReportDate: &rep, Positions: &pos, Pct: &pct},
			SF1:   features.ShortReading{Status: "reported", ReportDate: &rep, Positions: &pos, Pct: &pct},
		},
		FundamentalsHash: "abc",
	}
}

// Encode and decode are inverses on the stored feature object: a session read
// back is the session written.
func TestFeaturesRoundTrip(t *testing.T) {
	want := fixtureRow().Features
	raw, err := EncodeFeatures(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeFeatures(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip changed the features:\n got %+v\nwant %+v", got, want)
	}
}

func TestMetaRoundTripAndEmptyIsZero(t *testing.T) {
	mc := 9.5e8
	want := Meta{Name: "ALPHA LIMITED", Industry: "Materials", MarketCap: &mc, PricedSessions: 300}
	raw, err := EncodeMeta(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeMeta(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("meta round trip: got %+v want %+v", got, want)
	}
	zero, err := DecodeMeta(nil)
	if err != nil || !reflect.DeepEqual(zero, Meta{}) {
		t.Fatalf("an empty meta object decodes to the zero Meta: got %+v, %v", zero, err)
	}
}

// The stored keys are read by every reader of the rows, so they are pinned.
func TestMetaKeysAreTheStoredNames(t *testing.T) {
	raw, err := EncodeMeta(Meta{})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"market_cap", "priced_sessions"} {
		if _, ok := got[k]; !ok {
			t.Errorf("meta has no %q key; keys = %v", k, got)
		}
	}
	// The fundamentals' fetch times are written only when the row has them.
	fetched := time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)
	raw, err = EncodeMeta(Meta{GrowthFetchedAt: &fetched, QualityFetchedAt: &fetched})
	if err != nil {
		t.Fatal(err)
	}
	got = map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"growth_fetched_at", "quality_fetched_at"} {
		if _, ok := got[k]; !ok {
			t.Errorf("meta has no %q key; keys = %v", k, got)
		}
	}
}

func v0Spec(t *testing.T) spec.Spec {
	t.Helper()
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live version")
	}
	return reg.Spec
}

func TestEligibleInstrumentsAllNeedsPriceFeaturesAndSixtySessions(t *testing.T) {
	s := v0Spec(t)
	r := fixtureRow()
	meta, _ := EncodeMeta(Meta{PricedSessions: 300})
	r.Meta = meta
	if ok, reason := Eligible(r, s); !ok || reason != "" {
		t.Fatalf("a priced stock with 300 sessions is eligible under v0: got %v %q", ok, reason)
	}
	short, _ := EncodeMeta(Meta{PricedSessions: 12})
	r.Meta = short
	if ok, reason := Eligible(r, s); ok || reason != ReasonShortHistory {
		t.Fatalf("12 sessions is short history under v0: got %v %q", ok, reason)
	}
	r.Meta = meta
	r.Features.FS1 = features.PriceFeatures{}
	if ok, _ := Eligible(r, s); ok {
		t.Fatalf("a row without price features cannot be eligible")
	}
}

func TestEligibleOrdinaryUsesTheStoredUniverseFacts(t *testing.T) {
	s := v0Spec(t)
	s.Universe.Instruments = "ordinary"
	r := fixtureRow()
	r.OrdinaryFresh60 = false
	r.IneligibleReason = "exchange_traded_product"
	if ok, reason := Eligible(r, s); ok || reason != "exchange_traded_product" {
		t.Fatalf("ordinary universe reads the row's reason: got %v %q", ok, reason)
	}
	r.OrdinaryFresh60 = true
	s.Universe.ASICReported = true
	r.InASICReport = false
	if ok, reason := Eligible(r, s); ok || reason != "not_in_asic_report" {
		t.Fatalf("Crowded-Short style versions also need the ASIC report: got %v %q", ok, reason)
	}
}

func TestToCandidateReadsTheVersionsShortSource(t *testing.T) {
	s := v0Spec(t)
	r := fixtureRow()
	r.Features.SF0.Pct = ptr(1.0)
	r.Features.SF1.Pct = ptr(9.0)
	c, err := ToCandidate(r, s, features.Fundamentals{})
	if err != nil {
		t.Fatal(err)
	}
	if c.ShortPct == nil || *c.ShortPct != 1.0 {
		t.Fatalf("v0 reads sf0: short pct = %v, want 1", c.ShortPct)
	}
	s.Data.ShortSource = "latest_complete_published"
	c, err = ToCandidate(r, s, features.Fundamentals{})
	if err != nil {
		t.Fatal(err)
	}
	if c.ShortPct == nil || *c.ShortPct != 9.0 {
		t.Fatalf("v1 reads sf1: short pct = %v, want 9", c.ShortPct)
	}
}

func ptr(v float64) *float64 { return &v }

// A code with too little history has no price features. Its stored features
// must read back, and the zero date must never be written.
func TestFeaturesRoundTripWithoutPriceFeatures(t *testing.T) {
	in := Features{ExDiv: 0.25, SF1: features.ShortReading{Status: "none"}}
	raw, err := EncodeFeatures(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "0000-00-00") {
		t.Fatalf("the zero date must not be stored: %s", raw)
	}
	out, err := DecodeFeatures(raw)
	if err != nil {
		t.Fatalf("a short-history row must decode: %v", err)
	}
	if !out.FS1.AsOf.IsZero() || out.ExDiv != 0.25 || out.SF1.Status != "none" {
		t.Fatalf("round trip = %+v", out)
	}
	if (Row{Features: out}).HasPrice() {
		t.Fatal("a row with no price features must not report one")
	}
}
