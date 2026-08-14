package houseprices

import "testing"

func TestNSWCrosswalk_CoreMappings(t *testing.T) {
	cases := []struct {
		cat, subcat string
		want        crimeType
		ok          bool
	}{
		{"Theft", "Break and enter dwelling", crimeBreakIns, true},
		{"Assault", "Domestic violence related assault", crimeViolent, true},
		{"Assault", "Non-domestic violence related assault", crimeViolent, true},
		{"Theft", "Motor vehicle theft", crimeMotorVehicle, true},
		{"Malicious damage to property", "Malicious damage to property", crimePropertyDamage, true},
		// Robbery is mapped (Phase 3) but not a core type.
		{"Robbery", "Robbery without a weapon", crimeRobbery, true},
	}
	for _, c := range cases {
		got, ok := nswCrimeType(c.cat, c.subcat)
		if ok != c.ok || got != c.want {
			t.Errorf("nswCrimeType(%q,%q) = (%q,%v), want (%q,%v)", c.cat, c.subcat, got, ok, c.want, c.ok)
		}
	}
}

// The single easiest crosswalk bug: "steal FROM a motor vehicle" must NEVER map
// to motor_vehicle (theft OF a vehicle). Nor may non-dwelling break-ins land in
// break_ins, nor "Assault Police" in violent.
func TestNSWCrosswalk_TrapsExcluded(t *testing.T) {
	traps := []struct{ cat, subcat string }{
		{"Theft", "Steal from motor vehicle"},     // theft FROM vehicle
		{"Theft", "Break and enter non-dwelling"}, // non-residential
		{"Theft", "Steal from dwelling"},          // not a break-in
		{"Assault", "Assault Police"},             // excluded from the CVS-comparable core
		{"Theft", "Other theft"},
	}
	for _, tr := range traps {
		if ct, ok := nswCrimeType(tr.cat, tr.subcat); ok {
			t.Errorf("nswCrimeType(%q,%q) unexpectedly mapped to %q", tr.cat, tr.subcat, ct)
		}
	}
}

func TestNSWCrosswalk_TrimsWhitespace(t *testing.T) {
	if ct, ok := nswCrimeType("  Theft ", " Motor vehicle theft "); !ok || ct != crimeMotorVehicle {
		t.Errorf("whitespace-padded lookup failed: got (%q,%v)", ct, ok)
	}
}

func TestNormCVSLabel(t *testing.T) {
	cases := map[string]string{
		"Break–in": "break-in", // en-dash → hyphen
		"Total physical and/or threatened assault(d)": "total physical and/or threatened assault",
		"Motor vehicle theft":                         "motor vehicle theft",
		"  Malicious property  damage ":               "malicious property damage",
		"Robbery(d)":                                  "robbery",
		// Stacked footnotes must ALL be stripped, not just the last one.
		"Total physical and/or threatened assault(a)(d)": "total physical and/or threatened assault",
	}
	for in, want := range cases {
		if got := normCVSLabel(in); got != want {
			t.Errorf("normCVSLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCVSCrimeType(t *testing.T) {
	cases := []struct {
		label string
		want  crimeType
		ok    bool
	}{
		{"Break–in", crimeBreakIns, true},
		{"Motor vehicle theft", crimeMotorVehicle, true},
		{"Malicious property damage", crimePropertyDamage, true},
		{"Total physical and/or threatened assault(d)", crimeViolent, true},
		// Stacked footnote must still map the violent anchor.
		{"Total physical and/or threatened assault(a)(d)", crimeViolent, true},
		{"Attempted break–in", "", false}, // attempts excluded from break_ins
		{"Theft from a motor vehicle", "", false},
		{"Other theft(c)", "", false},
	}
	for _, c := range cases {
		got, ok := cvsCrimeType(c.label)
		if ok != c.ok || got != c.want {
			t.Errorf("cvsCrimeType(%q) = (%q,%v), want (%q,%v)", c.label, got, ok, c.want, c.ok)
		}
	}
}

// RSE-sheet block labels carry an "RSE of " prefix that must be stripped.
func TestCVSRSECrimeType(t *testing.T) {
	if ct, ok := cvsRSECrimeType("RSE of break–in"); !ok || ct != crimeBreakIns {
		t.Errorf("RSE break-in failed: got (%q,%v)", ct, ok)
	}
	if ct, ok := cvsRSECrimeType("RSE of motor vehicle theft"); !ok || ct != crimeMotorVehicle {
		t.Errorf("RSE motor_vehicle failed: got (%q,%v)", ct, ok)
	}
}

// The reporting-rate crosswalk proxies `violent` to "Physical assault" (the
// personal reporting-rate sheet has no "Total ... assault" block).
func TestCVSReportingCrimeType(t *testing.T) {
	if ct, ok := cvsReportingCrimeType("Physical assault"); !ok || ct != crimeViolent {
		t.Errorf("reporting violent proxy failed: got (%q,%v)", ct, ok)
	}
	if ct, ok := cvsReportingCrimeType("Break–in"); !ok || ct != crimeBreakIns {
		t.Errorf("reporting break-in failed: got (%q,%v)", ct, ok)
	}
}
