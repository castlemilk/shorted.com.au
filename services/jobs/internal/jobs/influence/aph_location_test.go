package influence

import "testing"

// Every input here is a real item-3 location line from the corpus.
func TestParseDeclaredLocation(t *testing.T) {
	cases := []struct {
		raw        string
		locality   string
		state      string
		purpose    string
		redacted   bool
		reject     string
		nameOfCase string
	}{
		{raw: "Greenvale, VIC", locality: "Greenvale", state: "VIC", nameOfCase: "suburb + code"},
		{raw: "Auchenflower, Queensland", locality: "Auchenflower", state: "QLD", nameOfCase: "full state name"},
		{raw: "Barton ACT", locality: "Barton", state: "ACT", nameOfCase: "no comma"},
		{raw: "Prospect Vale Tas", locality: "Prospect Vale", state: "TAS", nameOfCase: "two-word suburb, bare state"},
		{raw: "Island Beach (SA)", locality: "Island Beach", state: "SA", nameOfCase: "parenthesised state"},
		{raw: "Balgownie", locality: "Balgownie", state: "", nameOfCase: "no state at all"},
		{raw: "Aireys Inlet Vic", locality: "Aireys Inlet", state: "VIC", nameOfCase: "lowercase state token"},
		{raw: "Arana Hills, Qld", locality: "Arana Hills", state: "QLD", nameOfCase: "mixed-case state"},

		// The Purpose column bleeding into the location line.
		{raw: "Ballarat, VIC, Investment", locality: "Ballarat", state: "VIC", purpose: "Investment", nameOfCase: "purpose after state"},
		{raw: "Bayswater, Residential", locality: "Bayswater", state: "", purpose: "Residential", nameOfCase: "purpose, no state"},
		{raw: "Ayr, Queensland, Investment", locality: "Ayr", state: "QLD", purpose: "Investment", nameOfCase: "full state + purpose"},

		// Dwelling-type prefixes.
		{raw: "Apartment (Forrest, ACT)", locality: "Forrest", state: "ACT", nameOfCase: "dwelling prefix + parens"},
		{raw: "Apartment - Canberra, secondary", locality: "Canberra", state: "", purpose: "secondary", nameOfCase: "dwelling prefix + purpose"},

		// State written FIRST.
		{raw: "Australian Capital Territory, Kingston", locality: "Kingston", state: "ACT", nameOfCase: "state before locality"},

		// Street addresses: redacted to the locality. The street must never
		// survive — editorial standards §4 puts home addresses out of scope.
		{raw: "43 Lynjohn Drive, Bega", locality: "Bega", state: "", redacted: true, nameOfCase: "street address"},
		{raw: "26/47 Wentworth Avenue, Kingston", locality: "Kingston", state: "", redacted: true, nameOfCase: "unit + street"},
		{raw: "3 Kookaburra Court, Tura Beach", locality: "Tura Beach", state: "", redacted: true, nameOfCase: "street, two-word suburb"},

		// Prose and fragments.
		{raw: "22.5 per cent owned by another relative)", reject: "prose", nameOfCase: "ownership prose"},
		{raw: "All of the above, jointly", reject: "prose", nameOfCase: "cross-reference"},
		{raw: "All spouse / partner details", reject: "prose", nameOfCase: "meta statement"},
		{raw: "8.2 ML Low Reliability of 1A Greater", reject: "prose", nameOfCase: "water licence, not property"},
		{raw: "2025", reject: "prose", nameOfCase: "stray year"},
		{raw: "and myself with remaining 22.5 per cent owned by", reject: "prose", nameOfCase: "wrapped prose"},
		{raw: "", reject: "empty", nameOfCase: "empty"},
	}

	for _, tc := range cases {
		got := parseDeclaredLocation(tc.raw)
		if tc.reject != "" {
			if got.Reject == "" {
				t.Errorf("%s: %q was accepted, want reject %q", tc.nameOfCase, tc.raw, tc.reject)
			}
			continue
		}
		if got.Reject != "" {
			t.Errorf("%s: %q rejected as %q", tc.nameOfCase, tc.raw, got.Reject)
			continue
		}
		if got.Locality != tc.locality {
			t.Errorf("%s: locality = %q, want %q", tc.nameOfCase, got.Locality, tc.locality)
		}
		if got.StateCode != tc.state {
			t.Errorf("%s: state = %q, want %q", tc.nameOfCase, got.StateCode, tc.state)
		}
		if tc.purpose != "" && got.Purpose != tc.purpose {
			t.Errorf("%s: purpose = %q, want %q", tc.nameOfCase, got.Purpose, tc.purpose)
		}
		if got.Redacted != tc.redacted {
			t.Errorf("%s: redacted = %v, want %v", tc.nameOfCase, got.Redacted, tc.redacted)
		}
	}
}

// The single most important property in this file: a street address must never
// survive into anything storable. Editorial standards §4 — home addresses are
// out of scope, full stop, and we do not amplify the source over-disclosing.
func TestStreetAddressesAreNeverRetained(t *testing.T) {
	for _, raw := range []string{
		"43 Lynjohn Drive, Bega",
		"26/47 Wentworth Avenue, Kingston",
		"3 Kookaburra Court, Tura Beach",
		"48 Tura Beach Drive, Tura Beach",
	} {
		got := parseDeclaredLocation(raw)
		if !got.Redacted {
			t.Errorf("%q was not flagged as redacted", raw)
		}
		for _, forbidden := range []string{"Drive", "Avenue", "Court", "Lynjohn", "Wentworth", "Kookaburra", "43", "26/47", "3 ", "48"} {
			if containsFold(got.Locality, forbidden) {
				t.Errorf("%q leaked %q into locality %q", raw, forbidden, got.Locality)
			}
			if containsFold(got.LocalityNorm, forbidden) {
				t.Errorf("%q leaked %q into locality_norm %q", raw, forbidden, got.LocalityNorm)
			}
		}
	}

	// A bare street number with no suburb leaves nothing publishable at all.
	got := parseDeclaredLocation("14 Smith Street")
	if got.Reject == "" {
		t.Error("a street address with no suburb must be rejected outright")
	}
}

func containsFold(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		indexFold(haystack, needle) >= 0
}

func indexFold(s, sub string) int {
	ls, lsub := lower(s), lower(sub)
	for i := 0; i+len(lsub) <= len(ls); i++ {
		if ls[i:i+len(lsub)] == lsub {
			return i
		}
	}
	return -1
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func TestNormaliseLocality(t *testing.T) {
	cases := map[string]string{
		"Greenvale":       "GREENVALE",
		"  Tura  Beach  ": "TURA BEACH",
		"O'Connor":        "O CONNOR",
		"Eden-Monaro":     "EDEN MONARO",
		"St. Kilda":       "ST KILDA",
	}
	for in, want := range cases {
		if got := normaliseLocality(in); got != want {
			t.Errorf("normaliseLocality(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// The match ladder
// ---------------------------------------------------------------------------

func testSuburbIndex() (map[suburbKey]suburbMatch, map[string]suburbMatch) {
	byNameState := map[suburbKey]suburbMatch{
		{Name: "GREENVALE", State: "VIC"}:  {SalCode: "SAL21234", Count: 1},
		{Name: "GREENVALE", State: "QLD"}:  {SalCode: "SAL30987", Count: 1},
		{Name: "BEGA", State: "NSW"}:       {SalCode: "SAL10111", Count: 1},
		{Name: "SPRINGFIELD", State: "SA"}: {SalCode: "SAL40222", Count: 2}, // duplicate within one state
		{Name: "BALGOWNIE", State: "NSW"}:  {SalCode: "SAL10333", Count: 1},
	}
	byName := map[string]suburbMatch{
		"GREENVALE":   {SalCode: "SAL21234", Count: 2}, // ambiguous nationally
		"BEGA":        {SalCode: "SAL10111", Count: 1},
		"BALGOWNIE":   {SalCode: "SAL10333", Count: 1},
		"SPRINGFIELD": {SalCode: "SAL40222", Count: 2},
	}
	return byNameState, byName
}

func TestResolveDeclaredLocation(t *testing.T) {
	byNameState, byName := testSuburbIndex()

	// Name + state is the strong path.
	res := resolveDeclaredLocation(parseDeclaredLocation("Greenvale, VIC"), byNameState, byName)
	if res.Status != "resolved" || res.SalCode != "SAL21234" || res.MatchMethod != "name_state_exact" {
		t.Errorf("name+state: %+v", res)
	}

	// The same name in a different state is a different suburb.
	res = resolveDeclaredLocation(parseDeclaredLocation("Greenvale, QLD"), byNameState, byName)
	if res.SalCode != "SAL30987" {
		t.Errorf("state must disambiguate: %+v", res)
	}

	// A nationally unique name resolves without a state.
	res = resolveDeclaredLocation(parseDeclaredLocation("Balgownie"), byNameState, byName)
	if res.Status != "resolved" || res.MatchMethod != "name_national_unique" {
		t.Errorf("national unique: %+v", res)
	}
}

// Guessing which of two same-named suburbs a member owns property in is exactly
// the invention the editorial standards forbid.
func TestAmbiguousLocationsAreNeverGuessed(t *testing.T) {
	byNameState, byName := testSuburbIndex()

	// No state, and the name exists in more than one state.
	res := resolveDeclaredLocation(parseDeclaredLocation("Greenvale"), byNameState, byName)
	if res.Status != "no_state" {
		t.Errorf("status = %q, want no_state", res.Status)
	}
	if res.SalCode != "" {
		t.Errorf("a nationally ambiguous name resolved to %q", res.SalCode)
	}

	// Two suburbs share the name WITHIN one state.
	res = resolveDeclaredLocation(parseDeclaredLocation("Springfield, SA"), byNameState, byName)
	if res.Status != "ambiguous" || res.CandidateCount != 2 {
		t.Errorf("within-state duplicate: %+v", res)
	}
	if res.SalCode != "" {
		t.Errorf("an ambiguous location resolved to %q", res.SalCode)
	}
}

// The register asks for "suburb or area only", so an area name is a SOURCE
// CHARACTERISTIC, not a parser failure. The freshness alarm must key on
// ambiguous, never on region.
func TestKnownRegionsResolveAsRegionNotUnmatched(t *testing.T) {
	byNameState, byName := testSuburbIndex()
	for _, raw := range []string{"Central Coast", "Sunshine Coast", "Blue Mountains", "Riverina"} {
		res := resolveDeclaredLocation(parseDeclaredLocation(raw), byNameState, byName)
		if res.Status != "region" {
			t.Errorf("%q resolved as %q, want region", raw, res.Status)
		}
		if res.SalCode != "" {
			t.Errorf("%q resolved to a suburb %q", raw, res.SalCode)
		}
	}
}

func TestRedactedAddressStillResolvesItsSuburb(t *testing.T) {
	byNameState, byName := testSuburbIndex()
	loc := parseDeclaredLocation("43 Lynjohn Drive, Bega")
	res := resolveDeclaredLocation(loc, byNameState, byName)
	if res.Status != "resolved" || res.SalCode != "SAL10111" {
		t.Errorf("a redacted address should still place the suburb: %+v", res)
	}
	if !loc.Redacted {
		t.Error("redaction flag lost")
	}
}

func TestRejectedLocationsDoNotResolve(t *testing.T) {
	byNameState, byName := testSuburbIndex()
	for _, raw := range []string{"All of the above, jointly", "22.5 per cent owned by another relative)", ""} {
		res := resolveDeclaredLocation(parseDeclaredLocation(raw), byNameState, byName)
		if res.SalCode != "" {
			t.Errorf("%q resolved to %q", raw, res.SalCode)
		}
	}
}
