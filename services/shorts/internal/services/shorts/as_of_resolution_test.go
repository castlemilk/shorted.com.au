package shorts

import (
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// as_of and weekly bucketing are contradictory requests: a bucket labelled D
// contains observations from after D, so a weekly mean cannot answer a
// point-in-time question. Honouring both silently defeats the one the caller
// actually cares about. See castlemilk/shorted.com.au#584.

func TestAsOfImpliesFullResolution(t *testing.T) {
	r := &shortsv1alpha1.GetStockDataRequest{ProductCode: "bhp", Period: "max", AsOf: "2024-01-01"}
	SetDefaultValues(r)
	if !r.FullResolution {
		t.Fatal("as_of did not imply full_resolution; a point-in-time request would be served weekly means")
	}
}

func TestWithoutAsOfTheDefaultIsUnchanged(t *testing.T) {
	// The chart callers this default exists for must keep the series they render.
	r := &shortsv1alpha1.GetStockDataRequest{ProductCode: "bhp", Period: "max"}
	SetDefaultValues(r)
	if r.FullResolution {
		t.Fatal("full_resolution was set without as_of; the default changed for existing callers")
	}
}

func TestExplicitFullResolutionStillHonouredWithoutAsOf(t *testing.T) {
	r := &shortsv1alpha1.GetStockDataRequest{ProductCode: "bhp", Period: "max", FullResolution: true}
	SetDefaultValues(r)
	if !r.FullResolution {
		t.Fatal("an explicitly requested full_resolution was cleared")
	}
}

func TestAsOfDoesNotDisturbOtherDefaults(t *testing.T) {
	r := &shortsv1alpha1.GetStockDataRequest{ProductCode: "bhp", AsOf: "2024-01-01"}
	SetDefaultValues(r)
	if r.Period != "1M" {
		t.Errorf("Period = %q, want the 1M default", r.Period)
	}
	if r.ProductCode != "BHP" {
		t.Errorf("ProductCode = %q, want normalised BHP", r.ProductCode)
	}
	if !r.FullResolution {
		t.Error("as_of should still imply full_resolution on a defaulted period")
	}
}
