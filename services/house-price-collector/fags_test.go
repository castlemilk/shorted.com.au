package main

import "testing"

// TestNormCouncil pins the FAG↔ABS council name normalisation, especially the
// parenthetical-alias strip that fixed the 'Melbourne City Council (City of
// Melbourne)' edge-case, and guards the doubled-name names it must NOT collapse.
func TestNormCouncil(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// The edge-case: FAG appends the '(City of X)' alias, so without the paren
		// strip the suburb name appeared twice → "melbourne melbourne" ≠ "melbourne".
		{"Melbourne City Council (City of Melbourne)", "melbourne"},
		{"Melbourne", "melbourne"},
		// Renamed council: FAG keeps the old name in a parenthetical.
		{"Merri-bek City Council (formerly Moreland City Council)", "merri bek"},
		{"Merri-bek", "merri bek"},
		// ABS disambiguation suffix on the FAG side, stripped consistently.
		{"Central Coast Council (NSW)", "central coast"},
		{"Central Coast (NSW)", "central coast"},
		// Doubled names MUST survive (only bracketed spans are cut, not repeats).
		{"Wagga Wagga City Council", "wagga wagga"},
		{"Wagga Wagga", "wagga wagga"},
		{"Baw Baw Shire Council", "baw baw"},
		{"Wujal Wujal Aboriginal Council", "wujal wujal aboriginal"},
		// Existing council-type / stopword stripping still holds.
		{"City of Albany", "albany"},
		{"Alpine Shire Council", "alpine"},
		{"The Corporation of the City of Adelaide", "adelaide"},
		// Bare type words (LGPRF form: '<Name> City' / '<Name> Shire', no 'Council').
		{"Melbourne City", "melbourne"},
		{"Greater Geelong City", "greater geelong"},
		{"Yarra City", "yarra"},
		{"Alpine Shire", "alpine"},
		{"Ararat Rural City", "ararat"},
	}
	for _, c := range cases {
		if got := normCouncil(c.in); got != c.want {
			t.Errorf("normCouncil(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
