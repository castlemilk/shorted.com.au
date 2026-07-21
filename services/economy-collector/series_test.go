package main

import "testing"

func TestBuildKey(t *testing.T) {
	cases := []struct {
		def  SeriesDef
		want string
	}{
		{SeriesDef{Topic: "rates", Metric: "cash_rate_target", RegionCode: "aus", Adjustment: "original"},
			"rates.cash_rate_target.aus"},
		{SeriesDef{Topic: "petroleum", Metric: "refinery_output", Product: "diesel", RegionCode: "aus", Adjustment: "original"},
			"petroleum.refinery_output.diesel.aus"},
		{SeriesDef{Topic: "labour", Metric: "unemployment_rate", Product: "total", RegionCode: "nsw", Adjustment: "seasadj"},
			"labour.unemployment_rate.total.nsw.seasadj"},
	}
	for _, c := range cases {
		if got := c.def.Key(); got != c.want {
			t.Fatalf("Key() = %q, want %q", got, c.want)
		}
	}
}
