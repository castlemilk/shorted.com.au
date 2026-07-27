package main

import "testing"

// Regression tests for docs/politician-register-architecture.md §8.17 — the
// defects an adversarial review of the §8.15 fold change found in the LOADED
// corpus, every one of which was live on a public profile against a named
// member.
//
// EVERY string below is verbatim from register_item_securities. Synthetic
// strings would only prove the regexps match themselves.

// testHiddenLadder mirrors testLadder but carries the listings these cases
// name. The company_name values are the real (abbreviated) forms from
// "company-metadata" — see §2.1 on why they are mangled.
func testHiddenLadder() (map[string]SecurityAlias, map[string]string, map[string]CompanyNameMapping, map[string]int) {
	aliases := map[string]SecurityAlias{}
	codes := map[string]string{
		"VCX":  "Vicinity Centres",
		"TNE":  "Technology One",
		"MLB":  "Melbourne It",
		"AOG":  "Aveo Group Fpo/Units Stapled",
		"WAM":  "Wam Capital",
		"USA":  "Uraniumsa",
		"SELF": "Slfwlth Smsf Leadrs Etf Units",
		"ALC":  "Alcidion Group",
		"EDV":  "Endeavour Group",
		"MXT":  "Metrics Master Income Trust",
		"VTG":  "Vita Group",
	}
	// Keyed by normalizeEntityName, which strips a trailing corporate suffix
	// TWICE — "Endeavour Pty Ltd" and the listing "Endeavour Group" both
	// collapse to ENDEAVOUR, which is exactly how the EDV wrong link happened.
	names := map[string]CompanyNameMapping{
		"ENDEAVOUR":             {StockCode: "EDV", CompanyName: "Endeavour Group"},
		"METRICS MASTER INCOME": {StockCode: "MXT", CompanyName: "Metrics Master Income Trust"},
	}
	return aliases, codes, names, map[string]int{}
}

// §8.16's core defect: a cell naming a real ASX listing beside a private vehicle
// was chipped with the VEHICLE, and every vehicle chip's tooltip says "these are
// not on the ASX, so there is no ticker". The label denied the shareholding.
//
// These must never carry a vehicle kind again.
func TestMultiEntityCellsAreNeverChippedAsAVehicle(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	vehicles := map[string]bool{
		entityKindPrivateCompany: true,
		entityKindFamilyTrust:    true,
		entityKindSMSF:           true,
		entityKindManagedFund:    true,
	}

	for _, raw := range []string{
		// Two listings and a super fund in one cell. No splitter recovers this
		// one — abbreviationTail correctly refuses "Santos Ltd. Held".
		"Santos Ltd. Held by SMH Superannuation Fund: Amcor Ltd",
		// The member wrote "Listed Companies" themselves.
		"Superannuation Fund - Listed Companies: VCX",
		"Superannuation Fund- Listed Companies: VCX",
		"Spouse / Partner: Superannuation Fund - Listed Companies: TNE",
		"MFFO Wilcrow Pty Limited (a) Listed Companies MLB",
		// (a)/(b) enumerators grouping listed and private holdings.
		"SPY (b) Private Companies: Bonall Pty Limited",
		"PRRO (b) Private Companies: Bonedale Pty Limited",
		// More public-company suffixes than private ones.
		"Amcor Ltd Bronomics Pty Ltd Tyco International Ltd",
		"* Swanridge Investments Pty Ltd (jointly owned with Spouse) * Harvey Norman Holdings Ltd",
		"Astra Enterprise Qld Pty Ltd Scintilla Strategic Investments Ltd Citigroup (USA)",
		"a) Central Queensland Express Holdings Pty Ltd b) Toowoomba Express Couriers Ltd",
		// A foreign listing the member annotated as such.
		"Igas Energy Pty Ltd (UK listed) (Spouse/partner)",
		"Energy PTY LTD ( UK listed)",
		"Cybg PLC (jointly owned with spouse indirectly via Self Managed Superannuation Fund (SMSF))",
		// A ticker glossed with its own company name, inside a super vehicle.
		"AOG (AVEO Group) and WAM (Wilson Asset Management) by self and spouse in Wilson-Bolger Superannuation Pty Ltd.",
	} {
		res := resolveSecurityCandidate(makeCandidate(0, raw), aliases, codes, names, ambiguous, emptyWide)
		if vehicles[res.EntityKind] {
			t.Errorf("%q\n  chipped %q — that label denies a listing named in the same cell", raw, res.EntityKind)
		}
	}
}

// The counterpart, and the reason the rule is a RATIO and not a count: a member
// who declares one private company held through another is making a single
// declaration, correctly labelled. Withholding these buys no safety and loses
// 47 real rows.
func TestOrdinaryPrivateHoldingsStayPublished(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	for _, tc := range []struct{ raw, want string }{
		{"Growth Farms Pty Ltd (via Gufee Pty Ltd)", entityKindPrivateCompany},
		{"Maclaughlin River Holdings No.1 Pty Ltd (via Gufee Pty Ltd)", entityKindPrivateCompany},
		{"Gufee Pty Ltd Gufee Pastoral Co. Pty Ltd", entityKindPrivateCompany},
		{"Kenley Dale Pty Ltd Fairbank Tower Pty Ltd", entityKindPrivateCompany},
		{"Steel Harbour Pty Limited Babbage Hockey Pty Limited XAI Family Pty Limited Unaware of any other interests", entityKindPrivateCompany},
		{"Watts Kwok Pty Ltd acts solely as trustee for Watts Kwok Family Trust ACN 169 429 369", entityKindFamilyTrust},
		{"Klare (Qld) Pty Ltd Trustee for K & A Pitt Family Trust", entityKindFamilyTrust},
		{"Kenley Dale Pty Ltd (trustee of self-managed superannuation fund)", entityKindSMSF},
		{"Emu Foot Holdings Pty Ltd", entityKindPrivateCompany},
	} {
		res := resolveSecurityCandidate(makeCandidate(0, tc.raw), aliases, codes, names, ambiguous, emptyWide)
		if res.EntityKind != tc.want {
			t.Errorf("%q\n  entity_kind = %q, want %q", tc.raw, res.EntityKind, tc.want)
		}
	}
}

// A member who writes the ASX code themselves has given stronger evidence than
// any name match. The private veto used to swallow it, hiding the shareholding
// behind an SMSF chip. Measured corpus-wide: exactly 5 rows, all genuine.
func TestMemberStatedTickerSurvivesAVehicleMarker(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	for _, tc := range []struct{ raw, wantCode string }{
		{"Superannuation Fund - Listed Companies: VCX", "VCX"},
		{"Spouse / Partner: Superannuation Fund - Listed Companies: TNE", "TNE"},
		{"MFFO Wilcrow Pty Limited (a) Listed Companies MLB", "MLB"},
	} {
		c := makeCandidate(0, tc.raw)
		if c.Ticker != tc.wantCode {
			t.Errorf("%q: ticker = %q, want %q", tc.raw, c.Ticker, tc.wantCode)
		}
		_ = resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide)
	}
}

// The PARENTHESISED arm stays vetoed on a private entity, and it is not
// symmetric with the two above: it fires on exactly one vehicle row corpus-wide
// and that row is wrong. USA is UraniumSA.
func TestParenthesisedTickerStaysVetoedInsideAPrivateEntity(t *testing.T) {
	c := makeCandidate(0, "Astra Enterprise Qld Pty Ltd Scintilla Strategic Investments Ltd Citigroup (USA)")
	if c.Ticker != "" {
		t.Fatalf("ticker = %q; a parenthesised code inside a Pty Ltd blob must stay vetoed", c.Ticker)
	}
	// And the stopword is belt-and-braces, for any route that reaches it.
	if !tickerStopwords["USA"] {
		t.Error("USA must be a ticker stopword: it is UraniumSA, and it appears as a country")
	}
}

// A holder label is not a company. "SELF" is a real ASX code (SelfWealth SMSF
// Leaders ETF), so the ticker path published a FABRICATED ETF holding against a
// named member whose form merely had the label in the wrong column.
func TestHolderLabelsAreNotSecurities(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	for _, raw := range []string{
		"SELF", "Self", "self",
		"SPOUSE", "Spouse", "spouse", "spouse)",
		"Spouse/Partner:", "Spouse / Partner", "Partner",
		"Dependent Children", "Dependent", "Children",
	} {
		c := makeCandidate(0, raw)
		if c.Reject == "" {
			t.Errorf("%q was accepted as a security candidate", raw)
		}
		res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide)
		if res.Status == "resolved" || res.StockCode != "" {
			t.Errorf("%q resolved to %q — a holder label is not a holding", raw, res.StockCode)
		}
		if res.EntityKind != entityKindNotAnEntity {
			t.Errorf("%q: entity_kind = %q, want not_an_entity", raw, res.EntityKind)
		}
	}
}

// The anchoring is what makes the rule above safe. A real company whose name
// merely CONTAINS a holder word must be untouched.
func TestCompanyNamesContainingHolderWordsSurvive(t *testing.T) {
	for _, raw := range []string{
		"Turnbull & Partners Pty Limited",
		"Turnbull & Partners Holdings Pty Limited",
		"Save the Children",
		"Slater & Gordon Limited",
		"Pyne & Partners",
		"Rae & Partners Pty Ltd",
		"Child PsychCorp Pty Ltd",
		"Selfwealth Ltd",
	} {
		if c := makeCandidate(0, raw); c.Reject == "holder_label" {
			t.Errorf("%q was rejected as a holder label", raw)
		}
	}
}

// An amendment notice records a CHANGE, not a holding. Published as a holding it
// asserts the opposite of what the member wrote — two of these carried live ASX
// links to shareholdings the member was asking the registrar to remove.
func TestAmendmentNoticesAreNotHoldings(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	for _, raw := range []string{
		"please remove Listed Companies: VTG",
		"please remove Listed Companies: TNE",
		"Remove reference to Westpac (partner).",
		"Delete Branyan Investments Pty Ltd for self and spouse",
		"Delete shareholding in Sandgate Pest Control Pty Ltd",
		"Resignation as Director and Secretary of Firebeam Pty Ltd",
		"Sale of AGL shares held in joint names (David & Charlotte Gillespie)",
		"Sale of all AOG (AVEO Group) shares owned by self and husband in Wilson-Bolger Superannuation Pty Ltd on Monday",
		"Disposal of her shareholding in Scintilla Strategic Investments Limited",
		"I resigned as Company Director and Secretary of both Trisfall Pty Ltd and Kingmeadow Pty Ltd on 23 December 2014.",
	} {
		c := makeCandidate(0, raw)
		if c.Reject == "" {
			t.Errorf("%q was accepted as a holding", raw)
		}
		res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide)
		if res.StockCode != "" {
			t.Errorf("%q published a live link to %q — the member was recording the OPPOSITE", raw, res.StockCode)
		}
	}
}

// The verbs must be anchored at the start AND word-bounded. A company whose
// name merely BEGINS with the same letters is a real declaration — "Soldier"
// must not read as "sold", "Removalists" must not read as "remove".
//
// A name beginning with a whole amendment verb ("Ceased Holdings Ltd") would
// still be rejected. No such ASX listing exists, and the trade is deliberate:
// the alternative is publishing "Sale of AGL shares" as a current AGL holding.
func TestOrdinaryDeclarationsAreNotAmendmentNotices(t *testing.T) {
	for _, raw := range []string{
		"Soldier On Australia",
		"Removalists Pty Ltd",
		"Deleted Scenes Pty Ltd",
		"Resignation Systems Holdings", // "Resignation" only matches with "as"
		"Commonwealth Bank of Australia",
		"Woodside Energy Group Ltd",
		"Nolonger Pty Ltd",
	} {
		if c := makeCandidate(0, raw); c.Reject == "amendment_notice" {
			t.Errorf("%q was rejected as an amendment notice", raw)
		}
	}
}

// normalizeEntityName strips " LTD" and then " PTY", so a private company
// collapses onto a listing's name by coincidence. "Endeavour Pty Ltd" published
// a live /shorts/EDV link against a member's spouse's private company.
//
// The private veto must therefore run BEFORE the exact-name lookup — but still
// AFTER the curated alias and the member-stated ticker, which are decisions
// rather than coincidences.
func TestPrivateCompanyNeverMatchesAListingByName(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()

	res := resolveSecurityCandidate(makeCandidate(0, "Endeavour Pty Ltd"), aliases, codes, names, ambiguous, emptyWide)
	if res.StockCode != "" {
		t.Errorf("Endeavour Pty Ltd resolved to %q; a Pty Ltd is not the listed company it shares a word with", res.StockCode)
	}
	if res.EntityKind != entityKindPrivateCompany {
		t.Errorf("entity_kind = %q, want private_company", res.EntityKind)
	}

	// A genuinely listed trust must be unaffected: privateCompanyRe wants a
	// FAMILY trust, not a bare one.
	res = resolveSecurityCandidate(
		makeCandidate(0, "Metrics Master Income Trust"), aliases, codes, names, ambiguous, emptyWide)
	if res.StockCode != "MXT" {
		t.Errorf("Metrics Master Income Trust = %q, want MXT — a listed trust must still resolve", res.StockCode)
	}

	// A curated alias still outranks the veto: a human decided.
	aliases["ENDEAVOUR"] = SecurityAlias{
		StockCode: "EDV", AliasKind: "equity", Resolution: "resolved", DisplayName: "Endeavour Group",
	}
	if res := resolveSecurityCandidate(
		makeCandidate(0, "Endeavour Pty Ltd"), aliases, codes, names, ambiguous, emptyWide,
	); res.MatchMethod != "curated_alias" {
		t.Errorf("a curated alias must still win over the private veto, got %+v", res)
	}
}

// A holder label is not a place either. Two were published as declared real
// estate, rendering on a profile as somewhere the member owns property.
func TestHolderLabelsAreNotLocations(t *testing.T) {
	for _, raw := range []string{"Partner", "Self", "Spouse", "Dependent Children"} {
		if got := parseDeclaredLocation(raw); got.Reject != "holder_label" {
			t.Errorf("%q: reject = %q, want holder_label (locality %q)", raw, got.Reject, got.Locality)
		}
	}

	// Real localities that merely start with one of those letters are unaffected.
	for _, raw := range []string{"Selby, VIC", "Childers, QLD", "Partridge Island"} {
		if got := parseDeclaredLocation(raw); got.Reject == "holder_label" {
			t.Errorf("%q was rejected as a holder label", raw)
		}
	}
}

// namesMoreThanOneEntity must tolerate a nil listings map: only the ticker-gloss
// arm needs it, and the resolver is called from tests and tools that have none.
func TestMultiEntityDetectionToleratesNoListings(t *testing.T) {
	if !namesMoreThanOneEntity("Superannuation Fund - Listed Companies: VCX", nil) {
		t.Error("the listed-companies arm must not depend on the listings map")
	}
	if namesMoreThanOneEntity("AOG (AVEO Group) and WAM by self", nil) {
		t.Error("the ticker-gloss arm must be inert without a listings map")
	}
}

// A cell that is structurally not a place must be distinguishable from a suburb
// we merely failed to find: the fold falls back to the raw declared_text when
// there is no locality, so 'unmatched' published the non-place anyway.
func TestNonPlacesAreDistinguishedFromUnfoundSuburbs(t *testing.T) {
	byNameState := map[suburbKey]suburbMatch{}
	byName := map[string]suburbMatch{}

	for _, raw := range []string{
		"Self", "Partner", // holder labels published as declared real estate
		"Sale of Real Estate in Spearwood WA (Investment)",
		"Sold family home in Moonee Ponds. Purchased family home in",
		"Delete \"Kingston (Investment)\"",
		"no longer an interest in Maindample Victoria.",
	} {
		got := resolveDeclaredLocation(parseDeclaredLocation(raw), byNameState, byName)
		if got.Status != "not_a_location" {
			t.Errorf("%q: status = %q, want not_a_location", raw, got.Status)
		}
	}

	// A real property declaration we simply cannot geocode must stay
	// 'unmatched' and keep publishing its declared text.
	for _, raw := range []string{"Nowherexville, QLD", "Central Coast"} {
		if got := resolveDeclaredLocation(parseDeclaredLocation(raw), byNameState, byName); got.Status == "not_a_location" {
			t.Errorf("%q was discarded as a non-place; it is a property we failed to geocode", raw)
		}
	}
}

// splitLocalityAndState takes the first comma-part, so a line whose FIRST word
// is a holder label or a disposal verb yields that as the "locality". These
// published as places a member owns property in, and each also lost the real
// suburb further along the line.
func TestMangledLocalityIsRejectedNotPublished(t *testing.T) {
	byNameState := map[suburbKey]suburbMatch{}
	byName := map[string]suburbMatch{}

	for _, tc := range []struct{ raw, badLocality string }{
		{"Self, Residential, Canberra, ACT July 2023", "Self"},
		{"Partner residential property St Albans", "Partner"},
		{"Partner residential property Braybrook", "Partner"},
		{"Property Sale of", "Sale of"},
		{"Property sold - interest in one residential unit in Palm Beach, Queensland (investment)", "sold - interest in one"},
	} {
		loc := parseDeclaredLocation(tc.raw)
		if loc.Reject == "" {
			t.Errorf("%q: accepted with locality %q — that is not a place", tc.raw, loc.Locality)
		}
		if got := resolveDeclaredLocation(loc, byNameState, byName); got.Status != "not_a_location" {
			t.Errorf("%q: status = %q, want not_a_location", tc.raw, got.Status)
		}
	}

	// The ordinary shapes §3.5 lists must be untouched.
	for _, raw := range []string{
		"Greenvale, VIC", "Auchenflower, Queensland", "Barton ACT",
		"Island Beach (SA)", "Balgownie", "Apartment (Forrest, ACT)",
		"Ballarat, VIC, Investment", "Prospect Vale Tas",
	} {
		if loc := parseDeclaredLocation(raw); loc.Reject != "" {
			t.Errorf("%q: rejected as %q — this is a normal item-3 declaration", raw, loc.Reject)
		}
	}
}

// A family member is not a company. These rendered on profiles as declared
// company interests, one of them naming a member's minor children.
func TestFamilyMembersAreNotCompanies(t *testing.T) {
	for _, raw := range []string{
		"daughter Poppy Hunt and son James Hunt",
		"wife Louise Howarth.",
		"My wife has been employed by Valspar Group Pty Ltd.",
		"My wife Rebecca Mifsud has been appointed a Member of the Board of the Whitlam Institute",
		"Husband resigned as director of The Big Issue and Homes-for-Homes",
		"Son's on ground transport and internal flights within Cambodia met by Save the Children Australia.",
	} {
		if c := makeCandidate(0, raw); c.Reject == "" {
			t.Errorf("%q was published as a declared company interest", raw)
		}
	}
}

// "child" is an ordinary word in Australian company names, so it must NOT be a
// relation trigger. These are real declared entities.
func TestCompaniesNamedForChildrenSurvive(t *testing.T) {
	for _, raw := range []string{
		"Child Psych Corp Pty Ltd",
		"CHILD PSYCH CORP PTY LTD",
		"Bald Hills Child Care P/L",
		"Save the Children",
		"Sons of Gwalia Ltd",
	} {
		if c := makeCandidate(0, raw); c.Reject == "person_reference" {
			t.Errorf("%q was rejected as a person reference; it is a real entity", raw)
		}
	}
}

// An organisation's acronym is often a real ASX code, so gift/hospitality prose
// resolved to the WRONG COMPANY against a named member. Every string here was
// published live with a stock_code attached.
func TestGiftProseNeverResolvesToATicker(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()
	// The real codes these rows were resolving to.
	for _, c := range []string{"NRL", "AFL", "ARU", "RAC", "SCG", "WCE", "ABC", "NAB", "APL", "CII"} {
		codes[c] = "a real listing"
	}

	for _, raw := range []string{
		"pin and a football from the NRL",                                   // Albanese -> Newland Resources
		"State of Origin game at Lang Park as the guest of the NRL.",        // Perrett
		"Tickets and hospitality to State of Origin 3 NRL courtesy of NRL",  // Dutton
		"Tickets and hospitality - AFL Grand Final courtesy of AFL",         // Dutton
		"Tickets to Brumbies vs Waratahs ANZ Stadium courtesy ARU",          // Dutton
		"ROD STEWART CONCERT TICKETS HOSTED BY RAC",                         // Irons -> Racura Oncology
		"2 Tickets to AFL match Saturday 5th September Event hosted by WCE", // Irons
		"Received 2 x tickets to the New Year's Cricket Test at the SCG.",   // McCormack
		"2 Tickets to the Women's Australian Open from NAB",                 // Laundy - a real bank, but a GIFT
		"Australian Christmas Ham from Australian Port Limited (APL)",       // Fitzgibbon
	} {
		c := makeCandidate(0, raw)
		if c.Reject == "" {
			t.Errorf("%q was accepted as a holding", raw)
		}
		if res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide); res.StockCode != "" {
			t.Errorf("%q resolved to %q — that is a wrong company against a named member", raw, res.StockCode)
		}
	}
}

// The same acronyms must still resolve when a member genuinely declares them,
// and a real holding must survive the gift vocabulary.
func TestGenuineHoldingsSurviveTheGiftProseRule(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()
	codes["FLT"] = "Flight Centre Travel Group"
	codes["NRL"] = "Newland Resources"

	for _, tc := range []struct{ raw, wantCode string }{
		{"NRL", "NRL"},                     // a bare declared code still resolves
		{"FLT", "FLT"},                     // "flight" alone must NOT be a gift marker
		{"Flight Centre Travel Group", ""}, // name path, unaffected by the rule
		{"Commonwealth Bank of Australia", ""},
		{"The Lottery Corporation", ""},
		{"THE STAR ENTERTAINMENT", ""},
		{"BENDIGO AND ADELAIDE BANK", ""},
	} {
		c := makeCandidate(0, tc.raw)
		if c.Reject == "gift_prose" {
			t.Errorf("%q was rejected as gift prose; it is a real declaration", tc.raw)
		}
		if tc.wantCode != "" {
			if res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide); res.StockCode != tc.wantCode {
				t.Errorf("%q: code = %q, want %q", tc.raw, res.StockCode, tc.wantCode)
			}
		}
	}
}

// An organisation glossing its own acronym is not a member quoting a ticker.
// Blocking the ticker path is safe because the candidate still falls through to
// the NAME path — so a real listed company resolves anyway.
func TestSelfGlossedAcronymDoesNotBecomeATicker(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()
	codes["CII"], codes["WTC"], codes["CBA"], codes["IAG"] = "Ci Resources", "Wt Corp", "CBA", "IAG"
	names["COMMONWEALTH BANK OF AUSTRALIA"] = CompanyNameMapping{StockCode: "CBA", CompanyName: "Commonwealth Bank"}
	names["INSURANCE AUSTRALIA"] = CompanyNameMapping{StockCode: "IAG", CompanyName: "Insurance Australia Group"}

	// Gifts of a necktie from a trade body — must NOT carry a ticker.
	for _, raw := range []string{
		"Confederation of Indian Industry (CII) - Tie",
		"World Trade Centre (WTC) India - Tie",
	} {
		if c := makeCandidate(0, raw); c.Ticker != "" {
			t.Errorf("%q took ticker %q from its own initials", raw, c.Ticker)
		}
	}

	// Real companies whose acronym IS their ticker must still resolve — by name.
	for _, tc := range []struct{ raw, wantCode, wantMethod string }{
		{"Commonwealth Bank of Australia (CBA)", "CBA", "name_exact"},
		{"Insurance Australia Group (IAG)", "IAG", "name_exact"},
	} {
		res := resolveSecurityCandidate(makeCandidate(0, tc.raw), aliases, codes, names, ambiguous, emptyWide)
		if res.StockCode != tc.wantCode || res.MatchMethod != tc.wantMethod {
			t.Errorf("%q: got %q via %q, want %q via %q", tc.raw, res.StockCode, res.MatchMethod, tc.wantCode, tc.wantMethod)
		}
	}

	// A ticker that is NOT the initialism is untouched — this is the main path.
	if c := makeCandidate(0, "iShares S&P 500 ETF (IVV)"); c.Ticker != "IVV" {
		t.Errorf("iShares (IVV): ticker = %q, want IVV", c.Ticker)
	}
}

// emptyWide is the widened-name map for tests that do not exercise widening.
// The widened key is tried only AFTER the strict one misses, so an empty map
// makes every other test assert the strict ladder exactly as before.
var emptyWide = map[string]CompanyNameMapping{}

// The widened key is deterministic and applied to BOTH sides, so it is still an
// exact match — just on a wider key. It is tried only after the strict key has
// missed, and a widened name hitting two listings is dropped when the map is
// built, so it can never choose between companies.
func TestWidenEntityName(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"The Lottery Corporation", "LOTTERY"},
		{"Bendigo and Adelaide Bank", "BENDIGO ADELAIDE BANK"},
		{"Bendigo Adelaide Bank", "BENDIGO ADELAIDE BANK"},
		{"SOUTH 32", "SOUTH32"},
		{"Telstra shares", "TELSTRA"},
		{"Woodside Energy Group Ltd", "WOODSIDE ENERGY"},
		{"A2 Milk Company", "A2 MILK"},
		{"Commonwealth Bank Of Australia.", "COMMONWEALTH BANK OF AUSTRALIA"},
		// Repeated stripping, same reason normalizeEntityName strips twice.
		{"Sample Holdings Ltd", "SAMPLE"},
	} {
		if got := widenEntityName(tc.in); got != tc.want {
			t.Errorf("widenEntityName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The widened path must never override a strict match, and must never fire when
// the widened key is short enough to collide with the ticker namespace.
func TestWidenedMatchIsAdditiveOnly(t *testing.T) {
	aliases, codes, names, ambiguous := testHiddenLadder()
	wide := map[string]CompanyNameMapping{
		"LOTTERY": {StockCode: "TLC", CompanyName: "The Lottery Corporation"},
	}

	res := resolveSecurityCandidate(makeCandidate(0, "The Lottery Corporation"), aliases, codes, names, ambiguous, wide)
	if res.StockCode != "TLC" || res.MatchMethod != "name_exact" {
		t.Errorf("widened match: got %q via %q, want TLC via name_exact", res.StockCode, res.MatchMethod)
	}

	// A strict hit still wins and is unchanged by the widened map.
	names["ENDEAVOUR X"] = CompanyNameMapping{StockCode: "EDV", CompanyName: "Endeavour Group"}
	wide["ENDEAVOUR X"] = CompanyNameMapping{StockCode: "ZZZ", CompanyName: "Wrong"}
	if res := resolveSecurityCandidate(makeCandidate(0, "Endeavour X"), aliases, codes, names, ambiguous, wide); res.StockCode != "EDV" {
		t.Errorf("strict match must win: got %q", res.StockCode)
	}
}

// "FLIGHTS" as a whole cell is items 11-12 travel, but "Flight Centre Travel
// Group" is a real ASX listing (FLT). The nonSecurityRe alternation is anchored
// whole-string precisely so these two cannot be confused.
//
// This was caught by the alias proposer, which suggested FLIGHTS -> FLT with the
// rationale "Flight Centre Travel Group is commonly referred to as 'flights'".
// It is the NRL class of error, and it is why a human confirms every proposal.
func TestBareFlightsIsTravelButFlightCentreIsAListing(t *testing.T) {
	if c := makeCandidate(0, "FLIGHTS"); c.Reject == "" {
		t.Error("bare \"FLIGHTS\" was accepted as a security candidate")
	}
	if c := makeCandidate(0, "Flights"); c.Reject == "" {
		t.Error("bare \"Flights\" was accepted as a security candidate")
	}
	for _, raw := range []string{"Flight Centre Travel Group", "Flight Centre Travel Group Ltd"} {
		if c := makeCandidate(0, raw); c.Reject != "" {
			t.Errorf("%q rejected as %q — it is a real ASX listing", raw, c.Reject)
		}
	}
}
