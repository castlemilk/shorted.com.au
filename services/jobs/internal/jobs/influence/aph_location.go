package influence

// Resolves declared item-3 real-estate locations to ABS suburbs (sal_code).
//
// EDITORIAL (docs/influence-editorial-standards.md §4): home addresses are out
// of scope, full stop. The register asks for "suburb or area only", but members
// occasionally write a full street address anyway (measured: 8 of 714 lines).
// Those are REDACTED here — only the locality survives, and the street portion
// is never written to a column a read path can reach. We do not amplify a
// source's over-disclosure.
//
// The register asking for "suburb or area only" also means a 'region' result is a
// SOURCE CHARACTERISTIC, not a parser failure. Alarm on the ambiguous bucket,
// never on region.

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// streetTypeRe marks a line as containing a street address.
var streetTypeRe = regexp.MustCompile(`(?i)\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|crescent|cres|way|lane|ln|parade|pde|terrace|tce|close|cl|circuit|cct|grove|gr|boulevard|blvd|highway|hwy|esplanade|esp)\b\.?`)

// unitNumberRe matches a leading street/unit number: "26/47 ", "43 ", "3A ".
var unitNumberRe = regexp.MustCompile(`^\d+[A-Za-z]?(?:\s*/\s*\d+[A-Za-z]?)?\s+`)

// purposeTailRe strips the Purpose column where it has bled into the location
// line ("Ballarat, VIC, Investment", "Bayswater, Residential").
var purposeTailRe = regexp.MustCompile(`(?i)[,\s]+(residential|investment|rental|holiday|vacant land|vacant|commercial|farm(?:ing)?|primary production|office|business|secondary|principal place of residence|ppor|owner occupied|owner-occupied)\b.*$`)

// dwellingPrefixRe strips a dwelling-type prefix: "Apartment - Canberra",
// "Apartment (Forrest, ACT)", "Unit, Braddon".
var dwellingPrefixRe = regexp.MustCompile(`(?i)^(apartment|unit|house|townhouse|villa|flat|dwelling|property|land|block)\b[\s,\-–:]*`)

// locationProseRe rejects narrative and wrapped fragments. Real examples:
// "22.5 per cent owned by another relative)", "All of the above, jointly",
// "8.2 ML Low Reliability of 1A Greater" (a water licence, not a property).
var locationProseRe = regexp.MustCompile(`(?i)(per cent|percent|jointly with|all of the above|all spouse|see above|as above|refer to|owned by|acquired|disposed|settlement|settlment|water (licence|license)|\bML\b|not applicable|^and\b|^another\b|^\d{4}\)?$)`)

// australianStates maps every spelling the register uses onto the UPPERCASE
// codes suburb_demographics.state_code carries.
var australianStates = map[string]string{
	"NSW": "NSW", "NEW SOUTH WALES": "NSW",
	"VIC": "VIC", "VICTORIA": "VIC",
	"QLD": "QLD", "QUEENSLAND": "QLD",
	"SA": "SA", "SOUTH AUSTRALIA": "SA",
	"WA": "WA", "WESTERN AUSTRALIA": "WA",
	"TAS": "TAS", "TASMANIA": "TAS",
	"NT": "NT", "NORTHERN TERRITORY": "NT",
	"ACT": "ACT", "AUSTRALIAN CAPITAL TERRITORY": "ACT", "A.C.T.": "ACT",
}

// knownRegions are area names the register legitimately uses that are not ABS
// suburbs. They resolve to 'region', which is a source characteristic rather
// than a miss — see the file header.
var knownRegions = map[string]bool{
	"CENTRAL COAST": true, "SUNSHINE COAST": true, "GOLD COAST HINTERLAND": true,
	"BLUE MOUNTAINS": true, "RIVERINA": true, "HUNTER VALLEY": true,
	"BAROSSA VALLEY": true, "YARRA VALLEY": true, "MORNINGTON PENINSULA": true,
	"SOUTH WEST": true, "SOUTH COAST": true, "NORTH COAST": true,
	"WESTERN DISTRICT": true, "GIPPSLAND": true, "WHEATBELT": true,
	"GOLDFIELDS": true, "TOP END": true, "FAR NORTH QUEENSLAND": true,
}

// DeclaredLocation is one parsed real-estate location.
type DeclaredLocation struct {
	Raw          string
	Locality     string
	LocalityNorm string
	StateCode    string
	Purpose      string
	Redacted     bool   // a street address was removed
	Reject       string // non-empty => not a resolvable location
}

// parseDeclaredLocation reads one item-3 location line.
//
// Observed shapes, all real:
//
//	"Greenvale, VIC"                      suburb + code
//	"Auchenflower, Queensland"            suburb + full state name
//	"Barton ACT"                          no comma
//	"Island Beach (SA)"                   parenthesised state
//	"Balgownie"                           no state at all
//	"Ballarat, VIC, Investment"           purpose bled into the location column
//	"Apartment (Forrest, ACT)"            dwelling-type prefix
//	"Australian Capital Territory, Kingston"  state FIRST
//	"43 Lynjohn Drive, Bega"              street address -> redacted to "Bega"
func parseDeclaredLocation(raw string) DeclaredLocation {
	loc := DeclaredLocation{Raw: strings.TrimSpace(raw)}
	if loc.Raw == "" {
		loc.Reject = "empty"
		return loc
	}

	work := normaliseUnicode(loc.Raw)

	if locationProseRe.MatchString(work) {
		loc.Reject = "prose"
		return loc
	}

	// A holder label that escaped the form's label column is not a place. Two
	// were published as declared real estate — "Partner" and "Self" — each
	// rendered on a member's profile as somewhere they own property. Same rule
	// and same regexp as the security side; see holderLabelRe.
	if holderLabelRe.MatchString(work) {
		loc.Reject = "holder_label"
		return loc
	}

	// A disposal is not a holding. "Sale of Real Estate in Spearwood WA
	// (Investment)" and "Sold family home in Moonee Ponds" published as CURRENT
	// property against a named member — the opposite of what they wrote.
	//
	// Item 3 only. The same verbs are NOT safe corpus-wide: in item 10 (other
	// income) "Sale of stock and crops" is a farmer's income SOURCE, not an
	// amendment, and rejecting it would delete a real declaration.
	if amendmentNoticeRe.MatchString(work) {
		loc.Reject = "amendment_notice"
		return loc
	}

	// Peel the Purpose column off the tail before anything else, so
	// "Ballarat, VIC, Investment" does not lose VIC to the purpose grab.
	if m := purposeTailRe.FindStringSubmatch(work); m != nil {
		loc.Purpose = strings.TrimSpace(m[1])
		work = strings.TrimSpace(purposeTailRe.ReplaceAllString(work, ""))
	}

	// Redact a street address: keep ONLY what follows it. The street portion is
	// deliberately dropped here and never reaches a stored column.
	if unitNumberRe.MatchString(work) || streetTypeRe.MatchString(work) {
		if idx := strings.LastIndex(work, ","); idx >= 0 && idx+1 < len(work) {
			work = strings.TrimSpace(work[idx+1:])
			loc.Redacted = true
		} else if unitNumberRe.MatchString(work) {
			// A number with no comma leaves nothing safely publishable.
			loc.Reject = "street_address_only"
			loc.Redacted = true
			return loc
		}
	}

	work = strings.TrimSpace(dwellingPrefixRe.ReplaceAllString(work, ""))
	// Unwrap only when the WHOLE remainder is parenthesised
	// ("Apartment (Forrest, ACT)" -> "Forrest, ACT"). A blanket Trim would strip
	// the closing paren off "Island Beach (SA)" and the state parser — which
	// looks for a trailing "(STATE)" — would then never see it.
	if strings.HasPrefix(work, "(") && strings.HasSuffix(work, ")") {
		work = strings.TrimSpace(work[1 : len(work)-1])
	}

	locality, state := splitLocalityAndState(work)
	loc.StateCode = state
	loc.Locality = locality
	loc.LocalityNorm = normaliseLocality(locality)

	// The SAME two tests again, now against the EXTRACTED locality.
	//
	// The early checks above only see a cell that is nothing but a label. The
	// damage is done later, by splitLocalityAndState taking the first
	// comma-part: "Self, Residential, Canberra, ACT July 2023" yields locality
	// "Self", and "Partner residential property St Albans" yields "Partner".
	// Both published as a place the member owns property in, and both LOST the
	// real suburb (Canberra, St Albans) sitting further along the line.
	//
	// Rejecting only withholds the wrong fact; it does not recover the suburb.
	// Picking the right part of these lines is a separate change with its own
	// failure modes — see docs/politician-register-architecture.md §8.17.
	switch {
	case holderLabelRe.MatchString(loc.Locality):
		loc.Reject = "holder_label"
	case amendmentNoticeRe.MatchString(loc.Locality):
		loc.Reject = "amendment_notice"
	case loc.LocalityNorm == "":
		loc.Reject = "no_locality"
	case len(loc.LocalityNorm) < 3:
		loc.Reject = "too_short"
	}
	return loc
}

// splitLocalityAndState pulls a state out of the string in any observed
// position, and returns the remainder as the locality.
func splitLocalityAndState(s string) (locality, state string) {
	s = strings.TrimSpace(strings.Trim(s, ",;"))
	if s == "" {
		return "", ""
	}

	// Parenthesised: "Island Beach (SA)".
	paren := regexp.MustCompile(`\(([^)]+)\)\s*$`)
	if m := paren.FindStringSubmatch(s); m != nil {
		if code, ok := australianStates[strings.ToUpper(strings.TrimSpace(m[1]))]; ok {
			return strings.TrimSpace(paren.ReplaceAllString(s, "")), code
		}
	}

	// Comma-separated, either order: "Greenvale, VIC" or
	// "Australian Capital Territory, Kingston".
	if strings.Contains(s, ",") {
		parts := strings.Split(s, ",")
		var kept []string
		for _, part := range parts {
			trimmed := strings.TrimSpace(part)
			if code, ok := australianStates[strings.ToUpper(trimmed)]; ok && state == "" {
				state = code
				continue
			}
			if trimmed != "" {
				kept = append(kept, trimmed)
			}
		}
		if state != "" {
			return strings.Join(kept, " "), state
		}
		s = strings.Join(kept, " ")
	}

	// Trailing bare token: "Barton ACT", "Prospect Vale Tas".
	fields := strings.Fields(s)
	for take := 3; take >= 1; take-- {
		if len(fields) <= take {
			continue
		}
		tail := strings.ToUpper(strings.Join(fields[len(fields)-take:], " "))
		if code, ok := australianStates[tail]; ok {
			return strings.Join(fields[:len(fields)-take], " "), code
		}
	}

	return s, state
}

var localityCleanRe = regexp.MustCompile(`[^A-Z0-9 ]+`)

// normaliseLocality matches how suburb names are compared: uppercased,
// punctuation stripped, whitespace collapsed.
func normaliseLocality(s string) string {
	up := strings.ToUpper(strings.TrimSpace(s))
	up = localityCleanRe.ReplaceAllString(up, " ")
	return strings.Join(strings.Fields(up), " ")
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// suburbKey identifies a suburb candidate for matching.
type suburbKey struct {
	Name  string // normalised sal_name
	State string
}

type suburbMatch struct {
	SalCode string
	Count   int // how many suburbs share this (name, state)
}

// loadSuburbIndex builds the lookup from suburb_demographics.
//
// Two indexes, mirroring the ladder proven in house-price-collector's
// linkSuburbSalCodes: the plain name, and the ABS parenthetical-stripped form
// ("Abbotsford (NSW)" -> "Abbotsford").
func loadSuburbIndex(ctx context.Context, pool *pgxpool.Pool) (byNameState map[suburbKey]suburbMatch, byName map[string]suburbMatch, err error) {
	rows, err := pool.Query(ctx, `
		SELECT sal_code, sal_name, COALESCE(state_code, '')
		FROM suburb_demographics
		WHERE sal_name IS NOT NULL AND btrim(sal_name) <> ''`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	byNameState = map[suburbKey]suburbMatch{}
	byName = map[string]suburbMatch{}

	add := func(m map[string]suburbMatch, key, sal string) {
		if cur, ok := m[key]; ok {
			if cur.SalCode != sal {
				cur.Count++
				m[key] = cur
			}
			return
		}
		m[key] = suburbMatch{SalCode: sal, Count: 1}
	}

	stripParen := regexp.MustCompile(`\s*\([^)]*\)\s*$`)
	for rows.Next() {
		var sal, name, state string
		if err := rows.Scan(&sal, &name, &state); err != nil {
			return nil, nil, err
		}
		state = strings.ToUpper(strings.TrimSpace(state))

		for _, variant := range []string{name, stripParen.ReplaceAllString(name, "")} {
			norm := normaliseLocality(variant)
			if norm == "" {
				continue
			}
			key := suburbKey{Name: norm, State: state}
			if cur, ok := byNameState[key]; ok {
				if cur.SalCode != sal {
					cur.Count++
					byNameState[key] = cur
				}
			} else {
				byNameState[key] = suburbMatch{SalCode: sal, Count: 1}
			}
			add(byName, norm, sal)
		}
	}
	return byNameState, byName, rows.Err()
}

// LocationResolution is the outcome for one declared location.
type LocationResolution struct {
	SalCode        string
	Status         string
	MatchMethod    string
	CandidateCount int
}

// resolveDeclaredLocation applies the match ladder.
//
// A name that matches MORE than one suburb in the same state is 'ambiguous' and
// we never pick one — guessing which of two same-named suburbs a member owns
// property in is exactly the kind of invention the editorial standards forbid.
func resolveDeclaredLocation(
	loc DeclaredLocation,
	byNameState map[suburbKey]suburbMatch,
	byName map[string]suburbMatch,
) LocationResolution {
	if loc.Reject != "" {
		// A cell that is structurally NOT a place must be distinguishable from a
		// suburb we merely failed to find, because the fold falls back to the
		// raw declared_text whenever there is no locality — so 'unmatched'
		// published the non-place anyway.
		//
		// Prose, an unrecognised locality and a too-short fragment stay
		// 'unmatched' on purpose: those ARE property declarations, and their
		// declared text is worth publishing even ungeocoded.
		if loc.Reject == "holder_label" || loc.Reject == "amendment_notice" {
			return LocationResolution{Status: "not_a_location"}
		}
		return LocationResolution{Status: "unmatched"}
	}
	if knownRegions[loc.LocalityNorm] {
		return LocationResolution{Status: "region"}
	}

	if loc.StateCode != "" {
		if m, ok := byNameState[suburbKey{Name: loc.LocalityNorm, State: loc.StateCode}]; ok {
			if m.Count > 1 {
				return LocationResolution{Status: "ambiguous", CandidateCount: m.Count}
			}
			return LocationResolution{SalCode: m.SalCode, Status: "resolved", MatchMethod: "name_state_exact"}
		}
		return LocationResolution{Status: "unmatched"}
	}

	// No state stated. Only a nationally unique name is safe.
	if m, ok := byName[loc.LocalityNorm]; ok {
		if m.Count > 1 {
			return LocationResolution{Status: "no_state", CandidateCount: m.Count}
		}
		return LocationResolution{SalCode: m.SalCode, Status: "resolved", MatchMethod: "name_national_unique"}
	}
	return LocationResolution{Status: "unmatched"}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type locationResolveStats struct {
	Rows      int
	Resolved  int
	Ambiguous int
	Region    int
	NoState   int
	Unmatched int
	Redacted  int
	ByMethod  map[string]int
}

// runRegisterLocationResolve rebuilds the location links.
//
// One row per declared item, keyed by item_id (the table is UNIQUE on it), so a
// multi-property cell resolves to its FIRST resolvable line and the rest are
// reachable through declared_lines. Property counts therefore under-report
// rather than invent a second suburb from an ambiguous line.
func runRegisterLocationResolve(ctx context.Context, pool *pgxpool.Pool) (locationResolveStats, error) {
	stats := locationResolveStats{ByMethod: map[string]int{}}

	byNameState, byName, err := loadSuburbIndex(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load suburb index: %w", err)
	}
	if len(byNameState) == 0 {
		return stats, fmt.Errorf("suburb_demographics is empty — run the housing census ingest first")
	}

	type declaredRow struct {
		ID    string
		Text  string
		Lines []string
		Sec   string
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, declared_text, declared_lines, secondary_text
		FROM register_declared_items
		WHERE item_no = 3 AND NOT is_nil`)
	if err != nil {
		return stats, err
	}
	var items []declaredRow
	for rows.Next() {
		var r declaredRow
		if err := rows.Scan(&r.ID, &r.Text, &r.Lines, &r.Sec); err != nil {
			rows.Close()
			return stats, err
		}
		items = append(items, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		DELETE FROM register_item_locations
		WHERE match_method IS DISTINCT FROM 'curated'`); err != nil {
		return stats, err
	}

	batch := &pgx.Batch{}
	queued := 0
	for _, item := range items {
		lines := item.Lines
		if len(lines) == 0 && strings.TrimSpace(item.Text) != "" {
			lines = []string{item.Text}
		}

		// Pick the best line: a resolved one wins, else the first non-rejected.
		var best DeclaredLocation
		var bestRes LocationResolution
		found := false
		redacted := false
		for _, line := range lines {
			loc := parseDeclaredLocation(line)
			if loc.Redacted {
				redacted = true
			}
			res := resolveDeclaredLocation(loc, byNameState, byName)
			if !found || (bestRes.Status != "resolved" && res.Status == "resolved") {
				best, bestRes, found = loc, res, true
			}
			if bestRes.Status == "resolved" {
				break
			}
		}
		if !found {
			continue
		}

		stats.Rows++
		if redacted {
			stats.Redacted++
		}
		switch bestRes.Status {
		case "resolved":
			stats.Resolved++
			stats.ByMethod[bestRes.MatchMethod]++
		case "ambiguous":
			stats.Ambiguous++
		case "region":
			stats.Region++
		case "no_state":
			stats.NoState++
		default:
			stats.Unmatched++
		}

		var method any
		if bestRes.MatchMethod != "" {
			method = bestRes.MatchMethod
		}
		var sal any
		if bestRes.SalCode != "" {
			sal = bestRes.SalCode
		}
		var state any
		if best.StateCode != "" {
			state = best.StateCode
		}
		// locality_raw carries the REDACTED locality, never the street address.
		batch.Queue(`
			INSERT INTO register_item_locations
				(item_id, locality_raw, locality_norm, state_code, purpose_raw,
				 sal_code, resolution_status, match_method, candidate_count)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (item_id) DO UPDATE SET
				locality_raw      = EXCLUDED.locality_raw,
				locality_norm     = EXCLUDED.locality_norm,
				state_code        = EXCLUDED.state_code,
				purpose_raw       = EXCLUDED.purpose_raw,
				sal_code          = EXCLUDED.sal_code,
				resolution_status = EXCLUDED.resolution_status,
				match_method      = EXCLUDED.match_method,
				candidate_count   = EXCLUDED.candidate_count,
				resolved_at       = now()`,
			item.ID, best.Locality, best.LocalityNorm, state,
			firstNonEmpty(best.Purpose, item.Sec), sal, bestRes.Status, method,
			bestRes.CandidateCount)
		queued++
	}

	if queued > 0 {
		br := tx.SendBatch(ctx, batch)
		for range queued {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return stats, fmt.Errorf("insert location: %w", err)
			}
		}
		if err := br.Close(); err != nil {
			return stats, err
		}
	}

	return stats, tx.Commit(ctx)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
