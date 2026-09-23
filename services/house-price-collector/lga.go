package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Local Government Area (council) dimension + the suburb→council bridge, both
// precomputed offline by web/scripts/geo/join-lga-mb.py from ABS ASGS 2021
// mesh-block allocation files (SAL_2021, LGA_2024) weighted by Census 2021
// Mesh Block Counts. ABS, CC-BY-4.0. This loads the committed derived JSON and
// upserts lga + suburb_lga; it never fetches.
//
// Population is NOT written here: lga.population is ABS ERP, owned by
// -mode erp-lga. (It used to be a SUM of member suburbs' Census counts, which
// inherited every bridge error and ignored straddling suburbs.)

// LGARow is one council (UPSERT target on lga).
type LGARow struct {
	Code        string
	Name        string // ABS LGA_NAME_2024, e.g. 'Campbelltown (NSW)'
	DisplayName string // state suffix removed, e.g. 'Campbelltown'
	StateCode   string // 'OT' for Other Territories; '' only for Outside Australia
	Kind        string // council | unincorporated | pseudo
	AreaSqkm    *float64
	Dwellings   *int // Census 2021 mesh-block dwelling count
	CentroidLat *float64
	CentroidLon *float64
}

// LGAOverlap is one council's share of a suburb. JSON tags are the
// suburb_lga.overlap_lgas contract (000061): [{"lga_code24", "share"}].
type LGAOverlap struct {
	LGACode string  `json:"lga_code24"`
	Share   float64 `json:"share"`
}

// SuburbLGARow bridges a suburb to its dominant council, with every council
// holding >= 1% of its residents (dominant first).
type SuburbLGARow struct {
	SALCode       string
	LGACode       string
	DominantShare float64
	Overlaps      []LGAOverlap
}

const (
	lgaKindCouncil        = "council"
	lgaKindUnincorporated = "unincorporated"
	lgaKindPseudo         = "pseudo"

	// A bridge artifact this small is truncated, not a real redraw of the map;
	// replacing the table with it would silently orphan most suburbs.
	minSuburbLGABridgeRows = 10000
)

// lgaStateCode maps an ABS STATE_NAME_2021 to our state code. It extends the
// electorate map with "Other Territories" (Christmas Island, Cocos (Keeling)
// Islands, Jervis Bay, Norfolk Island): those are real councils and need a
// state for their URL. "Outside Australia" stays empty — it is a pseudo-area with
// no state by definition.
func lgaStateCode(absState string) string {
	if s := strings.TrimSpace(absState); s == "Other Territories" {
		return "OT"
	}
	return absStateToCode[strings.TrimSpace(absState)]
}

// lgaStateSuffixRe matches the only parentheticals in LGA_2024 names: the state
// suffix ABS adds when a name recurs across states ('Bayside (Vic.)').
var lgaStateSuffixRe = regexp.MustCompile(`\s*\((?:NSW|Vic\.|Qld|SA|WA|Tas\.|NT|ACT|OT)\)$`)

func lgaDisplayName(name string) string {
	return strings.TrimSpace(lgaStateSuffixRe.ReplaceAllString(name, ""))
}

// lgaKind classifies an ABS LGA_2024 row. Pseudo-areas are pinned by CODE —
// <state>9499 'No usual address', <state>9799 'Migratory - Offshore - Shipping',
// ZZZZZ 'Outside Australia' — never by label. Mirrored by classify_kind in
// join-lga-mb.py; TestLGAFactsArtifactAgreesWithCollector keeps them in step.
func lgaKind(code, name string) string {
	if code == "ZZZZZ" || (len(code) == 5 && (code[1:] == "9499" || code[1:] == "9799")) {
		return lgaKindPseudo
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "unincorp") {
		return lgaKindUnincorporated
	}
	return lgaKindCouncil
}

// lgaHasPage reports whether a council gets a public page (program decision 4).
func lgaHasPage(kind string) bool {
	return kind == lgaKindCouncil || kind == lgaKindUnincorporated
}

// lgaSlugBase turns a display name into a URL segment: ASCII-folded,
// lower-case, '&' spelled out, apostrophes dropped ("Break O'Day" →
// "break-oday"), everything else collapsed to single hyphens.
func lgaSlugBase(display string) string {
	s := norm.NFKD.String(strings.ToLower(display))
	s = strings.NewReplacer("&", " and ", "'", "", "’", "", "‘", "").Replace(s)
	var b strings.Builder
	dash := false
	for _, r := range s {
		switch {
		case r > unicode.MaxASCII:
			continue // combining marks left behind by NFKD
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimRight(b.String(), "-")
}

// mintLGASlugs assigns a slug to every page-bearing council that has none.
// Slugs are minted ONCE and never reassigned: they are the council's URL
// (/housing/<state>/council/<slug>), so a rename keeps the old slug, and a
// slug already held is never recomputed. `taken` is state → slug → holder code,
// read from the database. Collisions within a state (none exist in LGA_2024,
// but a future rename could make one) resolve to "<base>-<lga_code24>", which
// is stable and cannot itself collide. Pending rows are minted in code order
// so the outcome never depends on input order.
func mintLGASlugs(taken map[string]map[string]string, pending []LGARow) map[string]string {
	rows := append([]LGARow(nil), pending...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].Code < rows[j].Code })
	out := map[string]string{}
	for _, r := range rows {
		if !lgaHasPage(r.Kind) || r.StateCode == "" {
			continue
		}
		base := lgaSlugBase(r.DisplayName)
		if base == "" {
			continue
		}
		if taken[r.StateCode] == nil {
			taken[r.StateCode] = map[string]string{}
		}
		slug := base
		if holder, ok := taken[r.StateCode][slug]; ok && holder != r.Code {
			slug = base + "-" + strings.ToLower(r.Code)
		}
		taken[r.StateCode][slug] = r.Code
		out[r.Code] = slug
	}
	return out
}

func lgaFile(name string) string {
	if d := strings.TrimSpace(os.Getenv("LGA_DIR")); d != "" {
		return filepath.Join(d, name)
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", name)
}

// lgaFactsEntry is one council in lga-facts.json. kind/displayName/stateCode
// are also derived here from code + name + state; the loader refuses an
// artifact that disagrees rather than trusting either side silently.
type lgaFactsEntry struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	State       string   `json:"state"`
	StateCode   string   `json:"stateCode"`
	Kind        string   `json:"kind"`
	AreaSqkm    *float64 `json:"areaSqkm"`
	Dwellings   *int     `json:"dwellings"`
	CentroidLat *float64 `json:"centroidLat"`
	CentroidLon *float64 `json:"centroidLon"`
}

type suburbLGAEntry struct {
	LGA      string  `json:"lga"`
	Share    float64 `json:"share"`
	Overlaps []struct {
		LGA   string  `json:"lga"`
		Share float64 `json:"share"`
	} `json:"overlaps"`
}

// parseLGAFacts turns lga-facts.json into dimension rows, sorted by code.
func parseLGAFacts(raw map[string]lgaFactsEntry) ([]LGARow, error) {
	lgas := make([]LGARow, 0, len(raw))
	for code, f := range raw {
		r := LGARow{
			Code: code, Name: f.Name, DisplayName: lgaDisplayName(f.Name),
			StateCode: lgaStateCode(f.State), Kind: lgaKind(code, f.Name),
			AreaSqkm: f.AreaSqkm, Dwellings: f.Dwellings,
			CentroidLat: f.CentroidLat, CentroidLon: f.CentroidLon,
		}
		if f.Kind != r.Kind || f.DisplayName != r.DisplayName || f.StateCode != r.StateCode {
			return nil, fmt.Errorf("lga-facts.json %s %q disagrees with the collector: artifact kind=%q display=%q state=%q, derived kind=%q display=%q state=%q — regenerate with join-lga-mb.py",
				code, f.Name, f.Kind, f.DisplayName, f.StateCode, r.Kind, r.DisplayName, r.StateCode)
		}
		lgas = append(lgas, r)
	}
	sort.Slice(lgas, func(i, j int) bool { return lgas[i].Code < lgas[j].Code })
	return lgas, nil
}

// parseSuburbLGA turns suburb-lga.json into bridge rows, sorted by SAL. A
// missing overlaps list means the dominant council is the only one above 1%.
func parseSuburbLGA(raw map[string]suburbLGAEntry, known map[string]bool) ([]SuburbLGARow, error) {
	subs := make([]SuburbLGARow, 0, len(raw))
	for sal, e := range raw {
		if e.LGA == "" || e.Share <= 0 || e.Share > 1 {
			return nil, fmt.Errorf("suburb-lga.json %s: bad entry lga=%q share=%v (old {sal: lga} artifact? regenerate with join-lga-mb.py)", sal, e.LGA, e.Share)
		}
		if !known[e.LGA] {
			return nil, fmt.Errorf("suburb-lga.json %s: council %s is not in lga-facts.json", sal, e.LGA)
		}
		row := SuburbLGARow{SALCode: sal, LGACode: e.LGA, DominantShare: e.Share}
		if len(e.Overlaps) == 0 {
			row.Overlaps = []LGAOverlap{{LGACode: e.LGA, Share: e.Share}}
		} else {
			for _, o := range e.Overlaps {
				if !known[o.LGA] {
					return nil, fmt.Errorf("suburb-lga.json %s: overlap council %s is not in lga-facts.json", sal, o.LGA)
				}
				row.Overlaps = append(row.Overlaps, LGAOverlap{LGACode: o.LGA, Share: o.Share})
			}
			if row.Overlaps[0].LGACode != e.LGA {
				return nil, fmt.Errorf("suburb-lga.json %s: dominant council %s is not first in overlaps", sal, e.LGA)
			}
		}
		subs = append(subs, row)
	}
	sort.Slice(subs, func(i, j int) bool { return subs[i].SALCode < subs[j].SALCode })
	return subs, nil
}

// ingestLGA loads the council dimension + suburb→council bridge from the
// committed JSON.
func ingestLGA() ([]LGARow, []SuburbLGARow, error) {
	var facts map[string]lgaFactsEntry
	if err := readJSONFile(lgaFile("lga-facts.json"), &facts); err != nil {
		return nil, nil, err
	}
	lgas, err := parseLGAFacts(facts)
	if err != nil {
		return nil, nil, err
	}
	known := make(map[string]bool, len(lgas))
	for _, l := range lgas {
		known[l.Code] = true
	}
	var bridge map[string]suburbLGAEntry
	if err := readJSONFile(lgaFile("suburb-lga.json"), &bridge); err != nil {
		return nil, nil, fmt.Errorf("%w (suburb-lga.json must be the {sal: {lga, share, overlaps}} shape)", err)
	}
	subs, err := parseSuburbLGA(bridge, known)
	if err != nil {
		return nil, nil, err
	}
	if len(subs) < minSuburbLGABridgeRows {
		return nil, nil, fmt.Errorf("suburb-lga.json has %d suburbs (< %d): refusing to replace the bridge with a truncated artifact", len(subs), minSuburbLGABridgeRows)
	}
	return lgas, subs, nil
}
