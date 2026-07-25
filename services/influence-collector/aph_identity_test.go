package main

import (
	"slices"
	"strings"
	"testing"
)

func TestParseMemberHint(t *testing.T) {
	// Every hint is a real listing cell.
	cases := []struct {
		hint       string
		surname    string
		given      string
		honorific  string
		personKey  string
		display    string
		slugBase   string
		nameOfCase string
	}{
		{
			hint:    "Albanese, Hon Anthony, Member for Grayndler, NSW",
			surname: "Albanese", given: "Anthony", honorific: "Hon",
			personKey: "ALBANESE|ANTHONY", display: "Anthony Albanese", slugBase: "anthony-albanese",
			nameOfCase: "standard",
		},
		{
			hint:    "O'Brien, Mr Llew, Member for Wide Bay, QLD",
			surname: "O'Brien", given: "Llew", honorific: "Mr",
			personKey: "OBRIEN|LLEW", display: "Llew O'Brien", slugBase: "llew-o-brien",
			nameOfCase: "apostrophe surname",
		},
		{
			// A post-nominal glued to the surname forks one person into two.
			hint:    "Alexander OAM, Mr John, Member for Bennelong, NSW¹",
			surname: "Alexander", given: "John", honorific: "Mr",
			personKey: "ALEXANDER|JOHN", display: "John Alexander", slugBase: "john-alexander",
			nameOfCase: "post-nominal on the surname",
		},
		{
			hint:    "Kelly, Hon Dr Mike, Member for Eden-Monaro, NSW¹",
			surname: "Kelly", given: "Mike", honorific: "Hon Dr",
			personKey: "KELLY|MIKE", display: "Mike Kelly", slugBase: "mike-kelly",
			nameOfCase: "compound honorific + footnote",
		},
		{
			hint:    "Husic, The Hon Edham, Member for Chifley, NSW",
			surname: "Husic", given: "Edham", honorific: "The Hon",
			personKey: "HUSIC|EDHAM", display: "Edham Husic", slugBase: "edham-husic",
			nameOfCase: "'The Hon' honorific",
		},
		{
			hint:    "Aly, Professor Anne, Member for Cowan, WAW",
			surname: "Aly", given: "Anne", honorific: "Professor",
			personKey: "ALY|ANNE", display: "Anne Aly", slugBase: "anne-aly",
			nameOfCase: "academic title + footnote-suffixed state",
		},
		{
			hint:    "Hockey, The Hon Joe, Former Member for North Sydney, NSW",
			surname: "Hockey", given: "Joe", honorific: "The Hon",
			personKey: "HOCKEY|JOE", display: "Joe Hockey", slugBase: "joe-hockey",
			nameOfCase: "former member",
		},
		{
			hint:    "Le, Ms Dai, Member for Fowler, NSW",
			surname: "Le", given: "Dai", honorific: "Ms",
			personKey: "LE|DAI", display: "Dai Le", slugBase: "dai-le",
			nameOfCase: "two-letter surname",
		},
	}

	for _, tc := range cases {
		got := parseMemberHint(tc.hint)
		if got.Surname != tc.surname {
			t.Errorf("%s: surname = %q, want %q", tc.nameOfCase, got.Surname, tc.surname)
		}
		if got.GivenNames != tc.given {
			t.Errorf("%s: given = %q, want %q", tc.nameOfCase, got.GivenNames, tc.given)
		}
		if got.Honorific != tc.honorific {
			t.Errorf("%s: honorific = %q, want %q", tc.nameOfCase, got.Honorific, tc.honorific)
		}
		if got.PersonKey != tc.personKey {
			t.Errorf("%s: personKey = %q, want %q", tc.nameOfCase, got.PersonKey, tc.personKey)
		}
		if got.DisplayName != tc.display {
			t.Errorf("%s: display = %q, want %q", tc.nameOfCase, got.DisplayName, tc.display)
		}
		if got.SlugBase != tc.slugBase {
			t.Errorf("%s: slugBase = %q, want %q", tc.nameOfCase, got.SlugBase, tc.slugBase)
		}
	}
}

// The listing writes a member's given names inconsistently between parliaments.
// Keying on the full string forks one person into two, splitting their declared
// history in half.
func TestPersonKeyIsStableAcrossGivenNameVariants(t *testing.T) {
	a := parseMemberHint("Albanese, Hon Anthony, Member for Grayndler, NSW")
	b := parseMemberHint("Albanese, The Hon Anthony Norman, Member for Grayndler, NSW")
	if a.PersonKey != b.PersonKey {
		t.Errorf("person keys diverge across parliaments: %q vs %q", a.PersonKey, b.PersonKey)
	}
}

// Punctuation variants of the same surname must collapse to one key: the source
// spells names inconsistently, and a fork splits a member's history in half.
func TestPersonKeyIgnoresSurnamePunctuation(t *testing.T) {
	variants := []string{
		"O'Brien, Mr Llew, Member for Wide Bay, QLD",
		"OBrien, Mr Llew, Member for Wide Bay, QLD",
		"O Brien, Mr Llew, Member for Wide Bay, QLD",
	}
	keys := map[string]bool{}
	for _, h := range variants {
		keys[parseMemberHint(h).PersonKey] = true
	}
	if len(keys) != 1 {
		t.Errorf("punctuation variants produced %d keys, want 1: %v", len(keys), keys)
	}
	if !keys["OBRIEN|LLEW"] {
		t.Errorf("unexpected key set %v", keys)
	}
}

// The inverse risk, and the worse one: two different people must never collapse
// into one key. Same-surname members are common.
func TestDifferentPeopleWithTheSameSurnameGetDifferentKeys(t *testing.T) {
	hints := []string{
		"Chester, Mr Darren, Member for Gippsland",
		"Chesters, Ms Lisa, Member for Bendigo, VIC",
		"King, Hon Catherine, Member for Ballarat, VIC",
		"King, Ms Madeleine, Member for Brand, WA",
		"Wilson, Mr Josh, Member for Fremantle, WA",
		"Wilson, Mr Tim, Member for Goldstein, VIC",
	}
	seen := map[string]string{}
	for _, h := range hints {
		id := parseMemberHint(h)
		if prev, dup := seen[id.PersonKey]; dup {
			t.Errorf("key %q collides: %q and %q", id.PersonKey, prev, h)
		}
		seen[id.PersonKey] = h
	}
	if len(seen) != len(hints) {
		t.Errorf("got %d distinct keys for %d distinct members", len(seen), len(hints))
	}
}

func TestSlugCandidatesAreDeterministicAndDistinct(t *testing.T) {
	id := parseMemberHint("King, Ms Madeleine, Member for Brand, WA")
	got := slugCandidates(id, "WA")

	if got[0] != "madeleine-king" {
		t.Errorf("first candidate = %q, want the plain name", got[0])
	}
	if got[1] != "madeleine-king-wa" {
		t.Errorf("second candidate = %q, want the state-qualified form", got[1])
	}
	if !slices.Contains(got, "madeleine-king-2") {
		t.Errorf("expected a numbered fallback, got %v", got)
	}
	// Deterministic: the same input must always produce the same order, or a
	// re-run could mint a different slug for the same person.
	again := slugCandidates(id, "WA")
	if !slices.Equal(got, again) {
		t.Error("slug candidates are not deterministic")
	}
	for _, s := range got {
		if s == "" || strings.HasPrefix(s, "-") || strings.HasSuffix(s, "-") {
			t.Errorf("malformed slug candidate %q", s)
		}
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Anthony Albanese":  "anthony-albanese",
		"Llew O'Brien":      "llew-o-brien",
		"Dai Le":            "dai-le",
		"  Mike  Kelly  ":   "mike-kelly",
		"Zali Steggall OAM": "zali-steggall-oam",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseMemberHintHandlesJunk(t *testing.T) {
	for _, hint := range []string{"", "   ", ","} {
		id := parseMemberHint(hint)
		if id.PersonKey != "" {
			t.Errorf("parseMemberHint(%q) produced key %q; an unusable hint must stay unresolved", hint, id.PersonKey)
		}
	}
}

func TestCleanNameFieldStripsOnlyTrailingPostNominals(t *testing.T) {
	// A post-nominal is dropped...
	if got := cleanNameField("Alexander OAM", true); got != "Alexander" {
		t.Errorf("got %q, want Alexander", got)
	}
	// ...but a multi-word surname is not truncated.
	if got := cleanNameField("Van Manen", true); got != "Van Manen" {
		t.Errorf("got %q, want 'Van Manen'", got)
	}
	// Never strip the whole field.
	if got := cleanNameField("OAM", true); got != "OAM" {
		t.Errorf("got %q, want the field left intact", got)
	}
}
