package main

import "testing"

func TestAddressKey(t *testing.T) {
	cases := []struct {
		name                           string
		displayAddr, suburb, state, pc string
		want                           string
	}{
		{
			name:        "unit+street, suburb suffix present",
			displayAddr: "308/43 Devitt Street, Blacktown, NSW 2148", suburb: "Blacktown", state: "NSW", pc: "2148",
			want: "308-43-devitt-street-blacktown-nsw-2148",
		},
		{
			name:        "REA full display (spec example)",
			displayAddr: "1 Centre Road, Brighton, Vic 3186", suburb: "Brighton", state: "VIC", pc: "3186",
			want: "1-centre-road-brighton-vic-3186",
		},
		{
			name:        "Domain street-only display (spec example, cross-portal unification)",
			displayAddr: "1 Centre Road", suburb: "Brighton", state: "VIC", pc: "3186",
			want: "1-centre-road-brighton-vic-3186",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := addressKey(c.displayAddr, c.suburb, c.state, c.pc)
			if got != c.want {
				t.Errorf("addressKey(%q,%q,%q,%q) = %q, want %q", c.displayAddr, c.suburb, c.state, c.pc, got, c.want)
			}
		})
	}
}

// TestAddressKey_SameAddressDifferentFormats verifies formatting variance in the
// portal's OWN display string (case, extra whitespace, missing suffix) collapses
// to the same key once the canonical target suburb/state/postcode is applied.
func TestAddressKey_SameAddressDifferentFormats(t *testing.T) {
	want := "1-centre-road-brighton-vic-3186"
	variants := []string{
		"1 Centre Road, Brighton, Vic 3186",
		"1 centre road, brighton, VIC 3186",
		"  1 Centre Road,  Brighton , vic   3186  ",
		"1 Centre Road", // Domain-style, no suffix at all
	}
	for _, v := range variants {
		if got := addressKey(v, "Brighton", "VIC", "3186"); got != want {
			t.Errorf("addressKey(%q,...) = %q, want %q", v, got, want)
		}
	}
}

// TestAddressKey_CrossPortalUnification is the whole point of this feature:
// REA and Domain display the SAME address differently, but crawling both under
// the SAME CrawlTarget (canonical suburb/state/postcode) must yield one key.
func TestAddressKey_CrossPortalUnification(t *testing.T) {
	rea := addressKey("1 Centre Road, Brighton, Vic 3186", "Brighton", "VIC", "3186")
	domain := addressKey("1 Centre Road", "Brighton", "VIC", "3186")
	if rea == "" || rea != domain {
		t.Errorf("expected REA and Domain to unify to the same key, got rea=%q domain=%q", rea, domain)
	}
}

// TestAddressKey_MissingSuburbInDisplay covers a display address that omits the
// suburb (or any recognizable suffix) entirely — the whole string is treated as
// the street and the suburb/state/postcode are filled purely from the target.
func TestAddressKey_MissingSuburbInDisplay(t *testing.T) {
	got := addressKey("42 Example Ave", "Bondi", "NSW", "2026")
	want := "42-example-ave-bondi-nsw-2026"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestAddressKey_Garbage covers inputs that can never form a stable key.
func TestAddressKey_Garbage(t *testing.T) {
	cases := []struct {
		name                           string
		displayAddr, suburb, state, pc string
	}{
		{"empty everything", "", "", "", ""},
		{"blank display address", "   ", "Bondi", "NSW", "2026"},
		{"display address IS the suburb suffix (no street survives)", "Bondi, NSW 2026", "Bondi", "NSW", "2026"},
		{"missing suburb", "1 Centre Road", "", "VIC", "3186"},
		{"missing postcode", "1 Centre Road", "Brighton", "VIC", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := addressKey(c.displayAddr, c.suburb, c.state, c.pc); got != "" {
				t.Errorf("addressKey(%q,%q,%q,%q) = %q, want \"\"", c.displayAddr, c.suburb, c.state, c.pc, got)
			}
		})
	}
}

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"308/43 Devitt Street": "308-43-devitt-street",
		"  Brighton  ":         "brighton",
		"St Kilda":             "st-kilda",
		"O'Malley Cct.":        "o-malley-cct",
		"---":                  "",
		"":                     "",
	}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStreetPart(t *testing.T) {
	cases := []struct {
		addr, suburb, want string
	}{
		{"1 Centre Road, Brighton, Vic 3186", "Brighton", "1 Centre Road"},
		{"1 Centre Road", "Brighton", "1 Centre Road"}, // suburb absent -> whole string
		{"Brighton, NSW 2026", "Brighton", ""},         // nothing survives before the suburb
		{"", "Brighton", ""},
	}
	for _, c := range cases {
		if got := streetPart(c.addr, c.suburb); got != c.want {
			t.Errorf("streetPart(%q,%q) = %q, want %q", c.addr, c.suburb, got, c.want)
		}
	}
}
