package backtest

import (
	"testing"

	"cloud.google.com/go/civil"
)

// A disclosed run stores its same-data reference level on every recorded session (the
// stored series' r field). Before this, the simulator never set it and every record read
// zero, so no surface could show the reference. Reference capital is positive from the
// first session, so a zero level is always a missing write.
func TestDisclosedRunCarriesTheReferenceLevelOnEverySession(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	r := goldenRecipe(t)
	res, err := Run(in, s, r)
	if err != nil {
		t.Fatal(err)
	}
	last := res.Sessions[len(res.Sessions)-1]
	liveFrom := res.Sessions[len(res.Sessions)/2]
	_, base, err := Disclose(in, s, r, liveFrom, nil, last, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(base.Records) == 0 {
		t.Fatal("the disclosed run recorded no sessions")
	}
	var prev civil.Date
	for i, rec := range base.Records {
		if rec.Reference <= 0 {
			t.Fatalf("record %d (%s) carries reference %v, want the reference level", i, rec.Date, rec.Reference)
		}
		if i > 0 && !rec.Date.After(prev) {
			t.Fatalf("records out of order at %s", rec.Date)
		}
		prev = rec.Date
	}
}
