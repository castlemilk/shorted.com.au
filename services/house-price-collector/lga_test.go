package main

import (
	"math"
	"path/filepath"
	"strings"
	"testing"
)

func TestLGAKind(t *testing.T) {
	cases := []struct{ code, name, want string }{
		{"10050", "Albury", lgaKindCouncil},
		{"19399", "Unincorporated NSW", lgaKindUnincorporated},
		{"99399", "Unincorp. Other Territories", lgaKindUnincorporated},
		{"19499", "No usual address (NSW)", lgaKindPseudo},
		{"29799", "Migratory - Offshore - Shipping (Vic.)", lgaKindPseudo},
		{"ZZZZZ", "Outside Australia", lgaKindPseudo},
		// Pinned by CODE, never by label: a real council whose name happened
		// to read like a placeholder is still a council.
		{"12345", "No usual address", lgaKindCouncil},
	}
	for _, c := range cases {
		if got := lgaKind(c.code, c.name); got != c.want {
			t.Errorf("lgaKind(%q, %q) = %q, want %q", c.code, c.name, got, c.want)
		}
	}
	if lgaHasPage(lgaKindPseudo) || !lgaHasPage(lgaKindCouncil) || !lgaHasPage(lgaKindUnincorporated) {
		t.Error("only council and unincorporated areas get a page")
	}
}

func TestLGADisplayName(t *testing.T) {
	cases := map[string]string{
		"Campbelltown (NSW)":  "Campbelltown",
		"Bayside (Vic.)":      "Bayside",
		"Central Coast (Qld)": "Central Coast",
		"Latrobe (Tas.)":      "Latrobe",
		"Hills":               "Hills",
		// Only the trailing state suffix goes; other brackets stay.
		"No usual address (OT)": "No usual address",
		"Albury":                "Albury",
	}
	for in, want := range cases {
		if got := lgaDisplayName(in); got != want {
			t.Errorf("lgaDisplayName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Other Territories is a real ABS state with real councils, so councils get
// 'OT'; the shared electorate map must NOT learn it (electorates have no OT).
func TestLGAStateCode(t *testing.T) {
	if got := lgaStateCode("Other Territories"); got != "OT" {
		t.Errorf("Other Territories → %q, want OT", got)
	}
	if got := lgaStateCode("Outside Australia"); got != "" {
		t.Errorf("Outside Australia → %q, want ''", got)
	}
	if got := lgaStateCode(" New South Wales "); got != "NSW" {
		t.Errorf("New South Wales → %q, want NSW", got)
	}
	if _, ok := absStateToCode["Other Territories"]; ok {
		t.Error("absStateToCode must not map Other Territories: electorates.go shares it")
	}
}

func TestLGASlugBase(t *testing.T) {
	cases := map[string]string{
		"Albury":                       "albury",
		"Break O'Day":                  "break-oday",
		"Norwood Payneham & St Peters": "norwood-payneham-and-st-peters",
		"Merri-bek":                    "merri-bek",
		"Unincorp. Other Territories":  "unincorp-other-territories",
		"Bega Valley ":                 "bega-valley",
		"Kalgoorlie/Boulder":           "kalgoorlie-boulder",
		"Upper Hunter":                 "upper-hunter",
		"Glen Innes Severn":            "glen-innes-severn",
		"Queanbeyan-Palerang Regional": "queanbeyan-palerang-regional",
	}
	for in, want := range cases {
		if got := lgaSlugBase(in); got != want {
			t.Errorf("lgaSlugBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMintLGASlugs(t *testing.T) {
	rows := []LGARow{
		{Code: "40910", DisplayName: "Campbelltown", StateCode: "SA", Kind: lgaKindCouncil},
		{Code: "11500", DisplayName: "Campbelltown", StateCode: "NSW", Kind: lgaKindCouncil},
		{Code: "19499", DisplayName: "No usual address", StateCode: "NSW", Kind: lgaKindPseudo},
		{Code: "ZZZZZ", DisplayName: "Outside Australia", StateCode: "", Kind: lgaKindPseudo},
		{Code: "19399", DisplayName: "Unincorporated NSW", StateCode: "NSW", Kind: lgaKindUnincorporated},
	}
	got := mintLGASlugs(map[string]map[string]string{}, rows)
	want := map[string]string{"40910": "campbelltown", "11500": "campbelltown", "19399": "unincorporated-nsw"}
	if len(got) != len(want) {
		t.Fatalf("minted %v, want %v (pseudo-areas get no slug)", got, want)
	}
	for code, slug := range want {
		if got[code] != slug {
			t.Errorf("slug[%s] = %q, want %q (the same name in two states is not a collision)", code, got[code], slug)
		}
	}

	// A slug already held by another council in the state is never taken
	// from it: the newcomer gets the code-suffixed form. Input order does not
	// change the outcome.
	taken := map[string]map[string]string{"NSW": {"campbelltown": "19999"}}
	for _, order := range [][]LGARow{rows, {rows[4], rows[3], rows[2], rows[1], rows[0]}} {
		got = mintLGASlugs(copyTaken(taken), order)
		if got["11500"] != "campbelltown-11500" {
			t.Errorf("collision: slug = %q, want campbelltown-11500", got["11500"])
		}
		if got["40910"] != "campbelltown" {
			t.Errorf("another state's slug must not collide: %q", got["40910"])
		}
	}

	// Two new councils with the same base in one state: the lower code wins
	// the bare slug, deterministically.
	got = mintLGASlugs(map[string]map[string]string{}, []LGARow{
		{Code: "12000", DisplayName: "Twin", StateCode: "NSW", Kind: lgaKindCouncil},
		{Code: "11000", DisplayName: "Twin", StateCode: "NSW", Kind: lgaKindCouncil},
	})
	if got["11000"] != "twin" || got["12000"] != "twin-12000" {
		t.Errorf("same-state tie = %v, want 11000→twin, 12000→twin-12000", got)
	}
}

func copyTaken(in map[string]map[string]string) map[string]map[string]string {
	out := map[string]map[string]string{}
	for s, m := range in {
		out[s] = map[string]string{}
		for k, v := range m {
			out[s][k] = v
		}
	}
	return out
}

func TestParseSuburbLGA(t *testing.T) {
	known := map[string]bool{"A": true, "B": true}
	entry := func(lga string, share float64, overlaps ...[2]any) suburbLGAEntry {
		e := suburbLGAEntry{LGA: lga, Share: share}
		for _, o := range overlaps {
			e.Overlaps = append(e.Overlaps, struct {
				LGA   string  `json:"lga"`
				Share float64 `json:"share"`
			}{o[0].(string), o[1].(float64)})
		}
		return e
	}

	rows, err := parseSuburbLGA(map[string]suburbLGAEntry{
		"2": entry("A", 0.6, [2]any{"A", 0.6}, [2]any{"B", 0.4}),
		"1": entry("B", 1),
	}, known)
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].SALCode != "1" || rows[1].SALCode != "2" {
		t.Fatalf("rows not sorted by SAL: %+v", rows)
	}
	// A missing overlaps list means the dominant council is the only one.
	if len(rows[0].Overlaps) != 1 || rows[0].Overlaps[0] != (LGAOverlap{"B", 1}) {
		t.Errorf("single-council suburb overlaps = %+v", rows[0].Overlaps)
	}
	if len(rows[1].Overlaps) != 2 || rows[1].DominantShare != 0.6 {
		t.Errorf("straddler = %+v", rows[1])
	}

	for name, bad := range map[string]map[string]suburbLGAEntry{
		"old {sal: lga} shape": {"1": {}},
		"share above 1":        {"1": entry("A", 1.2)},
		"unknown council":      {"1": entry("Z", 1)},
		"unknown overlap":      {"1": entry("A", 0.9, [2]any{"A", 0.9}, [2]any{"Z", 0.1})},
		"dominant not first":   {"1": entry("A", 0.6, [2]any{"B", 0.4}, [2]any{"A", 0.6})},
	} {
		if _, err := parseSuburbLGA(bad, known); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

// The committed artifacts are the collector's only input for -mode lga. This
// loads them exactly as the mode does, so a regenerated artifact that the
// collector would refuse (or a classification that drifted between
// join-lga-mb.py and lga.go) fails here rather than in a prod run.
func TestLGAFactsArtifactAgreesWithCollector(t *testing.T) {
	t.Setenv("LGA_DIR", filepath.Join("..", "..", "web", "public", "geo", "insights"))
	lgas, subs, err := ingestLGA()
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	byCode := map[string]LGARow{}
	for _, l := range lgas {
		kinds[l.Kind]++
		byCode[l.Code] = l
		if l.StateCode == "" && l.Code != "ZZZZZ" {
			t.Errorf("%s %q has no state", l.Code, l.Name)
		}
		if strings.Contains(l.DisplayName, "(") && l.Kind != lgaKindPseudo {
			t.Errorf("%s display name %q kept a state suffix", l.Code, l.DisplayName)
		}
	}
	if kinds[lgaKindCouncil] < 500 || kinds[lgaKindPseudo] == 0 || kinds[lgaKindUnincorporated] == 0 {
		t.Errorf("kinds = %v", kinds)
	}
	if byCode["51710"].StateCode != "OT" {
		t.Errorf("Christmas Island state = %q, want OT", byCode["51710"].StateCode)
	}

	// The councils the centroid join got wrong, and suburbs it left unbridged.
	bySAL := map[string]SuburbLGARow{}
	for _, s := range subs {
		bySAL[s.SALCode] = s
		sum := 0.0
		for i, o := range s.Overlaps {
			sum += o.Share
			if i > 0 && o.Share > s.Overlaps[i-1].Share {
				t.Fatalf("%s overlaps not sorted desc: %+v", s.SALCode, s.Overlaps)
			}
		}
		if sum > 1.0001 || math.Abs(s.Overlaps[0].Share-s.DominantShare) > 1e-9 {
			t.Fatalf("%s: overlaps %+v disagree with dominant share %v", s.SALCode, s.Overlaps, s.DominantShare)
		}
	}
	for sal, want := range map[string]string{
		"10589": "Broken Hill",          // Broken Hill (was Unincorporated NSW)
		"11239": "Edward River",         // Deniliquin (was Murray River)
		"22582": "Wyndham",              // Truganina (was Melton)
		"20779": "Whittlesea",           // Doreen (was Nillumbik)
		"20496": "Yarra",                // Carlton North (was Melbourne)
		"12462": "Randwick",             // Malabar (was unbridged)
		"12166": "Canterbury-Bankstown", // Kingsgrove (was unbridged; a three-council straddler)
	} {
		got, ok := bySAL[sal]
		if !ok {
			t.Errorf("SAL %s (%s) is not bridged", sal, want)
			continue
		}
		if name := byCode[got.LGACode].DisplayName; name != want {
			t.Errorf("SAL %s → %s, want %s", sal, name, want)
		}
	}
}
