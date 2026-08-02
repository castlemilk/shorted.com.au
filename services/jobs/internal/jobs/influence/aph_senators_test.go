package influence

// The derivation, not the plumbing.
//
// Every fixture below is a REAL shape lifted from the live Handbook payload
// (1,879 records), because the cases that matter are the ones the source
// actually produces: the four dual-chamber careers, the 1900-01-01 ongoing
// marker, the today's-date end, the mixed-case surname prefixes. A synthetic
// fixture that is merely plausible tests the code against its author's
// assumptions rather than against the feed.

import (
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func houseTerm(electorate, start, end string) handbookElectorateTerm {
	return handbookElectorateTerm{Electorate: electorate, ServiceStart: start, ServiceEnd: end}
}

func service(start, end string, parties ...[3]string) handbookServiceInterval {
	iv := handbookServiceInterval{RoSType: "Parliamentary Service", DateStart: start, DateEnd: end}
	for _, p := range parties {
		iv.SecondaryService = append(iv.SecondaryService, handbookServiceInterval{
			RoSType: "Parties Represented", Value: p[0], DateStart: p[1], DateEnd: p[2],
		})
	}
	return iv
}

// today is what the Handbook writes as the end of an ONGOING interval — it
// generates the payload per request, so a current term ends "now".
var today = time.Now().UTC().Format("2006-01-02")

// THE FOUR DUAL-CHAMBER CASES, each a different way the flat
// RepresentedParliaments list is wrong on its own.
func TestSenateParliamentsAreDerivedByDateSubtraction(t *testing.T) {
	cases := []struct {
		name string
		in   handbookIndividual
		want []int
	}{
		{
			// A House term in the 38th, then a Senate career from the 45th. The
			// flat list holds [38 45 46 47 48]; only the dates say the 38th is
			// the House one.
			name: "Hanson: House first, Senate two decades later",
			in: handbookIndividual{
				PHID: "BK6", FamilyName: "HANSON", GivenName: "Pauline",
				SenateState: "Queensland", MPorSenator: []string{"Senator", "Member"},
				RepresentedParliaments: []int{38, 45, 46, 47, 48},
				ElectorateService:      []handbookElectorateTerm{houseTerm("Oxley", "1996-03-02", "1998-10-03")},
				PartyParliamentaryService: []handbookServiceInterval{
					service("1996-03-02", "1998-10-03"),
					service("2016-07-02", "2022-06-30"),
					service("2022-07-01", today),
				},
			},
			want: []int{45, 46, 47, 48},
		},
		{
			// Two House terms, then a CASUAL VACANCY four months into the 46th.
			// The 44th and 45th must not become Senate terms.
			name: "Henderson: House 44-45, Senate from a casual vacancy in 46",
			in: handbookIndividual{
				PHID: "ZN4", FamilyName: "HENDERSON", GivenName: "Sarah",
				SenateState: "Victoria", MPorSenator: []string{"Senator", "Member"},
				RepresentedParliaments: []int{44, 45, 46, 47, 48},
				ElectorateService: []handbookElectorateTerm{
					houseTerm("Corangamite", "2016-07-02", "2019-05-18"),
					houseTerm("Corangamite", "2013-09-07", "2016-07-02"),
				},
				PartyParliamentaryService: []handbookServiceInterval{
					service("2013-09-07", "2016-07-02"),
					service("2016-07-02", "2019-05-18"),
					service("2019-09-11", "2022-06-30"),
					service("2022-07-01", today),
				},
			},
			want: []int{46, 47, 48},
		},
		{
			// The newest case, and the one where the House term ends at
			// DISSOLUTION rather than at the next election.
			name: "Ananda-Rajah: House 47, Senate 48",
			in: handbookIndividual{
				PHID: "290544", FamilyName: "ANANDA-RAJAH", GivenName: "Michelle",
				SenateState: "Victoria", MPorSenator: []string{"Senator", "Member"},
				RepresentedParliaments: []int{47, 48},
				ElectorateService:      []handbookElectorateTerm{houseTerm("Higgins", "2022-05-21", "2025-03-28")},
				PartyParliamentaryService: []handbookServiceInterval{
					service("2022-05-21", "2025-03-28"),
					service("2025-07-01", today),
				},
			},
			want: []int{48},
		},
		{
			// Senate 1987-1994, then Mackellar. Her Senate service is entirely
			// below the floor, so she gets NO Senate term — and the 44th, which
			// she did sit, must stay House-only.
			name: "Bishop: Senate service all predates the floor",
			in: handbookIndividual{
				PHID: "SE4", FamilyName: "BISHOP", GivenName: "Bronwyn",
				SenateState: "New South Wales", MPorSenator: []string{"Member", "Senator"},
				RepresentedParliaments: []int{35, 36, 37, 38, 39, 40, 41, 42, 43, 44},
				ElectorateService: []handbookElectorateTerm{
					houseTerm("Mackellar", "2013-09-07", "2016-05-09"),
					houseTerm("Mackellar", "1994-03-26", "1996-03-02"),
				},
				PartyParliamentaryService: []handbookServiceInterval{
					service("1987-07-11", "1990-06-30"),
					service("1990-07-01", "1994-02-24"),
					service("1994-03-26", "1996-03-02"),
					service("2013-09-07", "2016-05-09"),
				},
			},
			want: nil,
		},
		{
			// A pure senator: every claimed parliament from the floor up.
			name: "Canavan: no House service to subtract",
			in: handbookIndividual{
				PHID: "245212", FamilyName: "CANAVAN", GivenName: "Matthew",
				SenateState: "Queensland", MPorSenator: []string{"Senator"},
				RepresentedParliaments: []int{44, 45, 46, 47, 48},
				PartyParliamentaryService: []handbookServiceInterval{
					service("2014-07-01", "2016-07-02"),
					service("2016-07-02", "2022-06-30"),
					service("2022-07-01", today),
				},
			},
			want: []int{44, 45, 46, 47, 48},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := termParliaments(deriveSenateTerms(tc.in))
			if len(got) != len(tc.want) {
				t.Fatalf("parliaments %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("parliaments %v, want %v", got, tc.want)
				}
			}
		})
	}
}

// 1900-01-01 IS NOT A DATE HERE. It is the Handbook's "still running" marker,
// and it sorts BEFORE every real date in the corpus — so parsing it turns a
// sitting member's current term into one that ended in 1900 and inverts every
// interval comparison downstream. Barnaby Joyce's current House term carries it,
// and if it were parsed his House service would stop covering the 48th and the
// 48th would be derived as a SENATE term for a man who is a member.
func TestOngoingMarkerIsNeverParsedAsATerm(t *testing.T) {
	if _, ok := parseHandbookDate(handbookOngoingDate); ok {
		t.Fatalf("1900-01-01 parsed as a real date")
	}
	iv, ok := handbookInterval("2025-05-03", handbookOngoingDate)
	if !ok {
		t.Fatalf("an ongoing interval must still be an interval")
	}
	if !iv.To.Equal(dateOpen) {
		t.Fatalf("ongoing end = %v, want the open sentinel", iv.To)
	}

	joyce := handbookIndividual{
		PHID: "E5D", FamilyName: "JOYCE", GivenName: "Barnaby",
		SenateState: "Queensland", MPorSenator: []string{"Member", "Senator"},
		RepresentedParliaments: []int{44, 45, 46, 47, 48},
		ElectorateService: []handbookElectorateTerm{
			houseTerm("New England", "2025-05-03", handbookOngoingDate),
			houseTerm("New England", "2022-05-21", "2025-05-03"),
			houseTerm("New England", "2019-05-18", "2022-05-21"),
			houseTerm("New England", "2016-07-02", "2019-05-18"),
			houseTerm("New England", "2013-09-07", "2016-07-02"),
		},
		PartyParliamentaryService: []handbookServiceInterval{
			service("2005-07-01", "2013-08-08"),
			service("2013-09-07", "2016-07-02"),
			service("2016-07-02", "2019-05-18"),
			service("2019-05-18", "2022-05-21"),
			service("2022-05-21", "2025-05-03"),
			service("2025-05-03", today),
		},
	}
	if got := termParliaments(deriveSenateTerms(joyce)); len(got) != 0 {
		t.Fatalf("a sitting MEMBER was given senate terms %v", got)
	}

	// A start that cannot be read withholds the whole interval rather than
	// being guessed at.
	if _, ok := handbookInterval(handbookOngoingDate, "2025-05-03"); ok {
		t.Fatalf("an interval with an unreadable start must withhold")
	}
}

// A term's dates say only what the parliament does not already say.
func TestTermDatesRecordOnlyMidParliamentBoundaries(t *testing.T) {
	henderson := handbookIndividual{
		PHID: "ZN4", FamilyName: "HENDERSON", GivenName: "Sarah",
		SenateState: "Victoria", MPorSenator: []string{"Senator", "Member"},
		RepresentedParliaments: []int{46, 47, 48},
		PartyParliamentaryService: []handbookServiceInterval{
			service("2019-09-11", "2022-06-30"),
			service("2022-07-01", today),
		},
	}
	terms := deriveSenateTerms(henderson)
	byParliament := map[int]senateTerm{}
	for _, term := range terms {
		byParliament[term.Parliament] = term
	}

	// A casual vacancy four months into the 46th is a fact about HER.
	got46 := byParliament[46]
	if got46.Start == nil || !got46.Start.Equal(day("2019-09-11")) {
		t.Errorf("46th start = %v, want 2019-09-11", got46.Start)
	}
	// Serving the whole 47th is not: writing election day as a start would say
	// she began then, and writing the next election as an end would say she
	// stopped. The parliament turned over; she did not.
	if got47 := byParliament[47]; got47.Start != nil || got47.End != nil {
		t.Errorf("47th = [%v, %v], want both unset", got47.Start, got47.End)
	}
	// And the CURRENT term is open, not ended today.
	if got48 := byParliament[48]; got48.End != nil {
		t.Errorf("48th ends %v — the Handbook writes today's date for an ongoing term", got48.End)
	}
}

// Surnames arrive upper-cased EXCEPT for prefixes the Handbook preserves.
func TestSenatorSurnameKeepsMixedCasePrefixes(t *testing.T) {
	cases := map[string]string{
		"McGRATH":           "McGrath",
		"MacDONALD":         "MacDonald",
		"O'NEILL":           "O'Neill",
		"ANANDA-RAJAH":      "Ananda-Rajah",
		"DI NATALE":         "Di Natale",
		"NAMPIJINPA PRICE":  "Nampijinpa Price",
		"FIERRAVANTI-WELLS": "Fierravanti-Wells",
		"CANAVAN":           "Canavan",
	}
	for in, want := range cases {
		if got := senatorSurname(in); got != want {
			t.Errorf("senatorSurname(%q) = %q, want %q", in, got, want)
		}
	}
}

// person_key is FORMAL; the slug and the display name are PREFERRED; and the
// preferred key becomes an alias rather than a second identity.
func TestIdentityKeysSplitFormalFromPreferred(t *testing.T) {
	id, ok := buildSenatorIdentity(handbookIndividual{
		PHID: "245212", FamilyName: "CANAVAN", GivenName: "Matthew",
		MiddleNames: "James", PreferredName: "(Matt)", SenateState: "Queensland",
		MPorSenator: []string{"Senator"}, RepresentedParliaments: []int{48},
		PartyParliamentaryService: []handbookServiceInterval{service("2022-07-01", today)},
	})
	if !ok {
		t.Fatal("identity withheld")
	}
	if id.PersonKey != "CANAVAN|MATTHEW" {
		t.Errorf("person_key = %q, want CANAVAN|MATTHEW (the FORMAL given name)", id.PersonKey)
	}
	if id.PreferredKey != "CANAVAN|MATT" {
		t.Errorf("preferred key = %q, want CANAVAN|MATT", id.PreferredKey)
	}
	if id.DisplayName != "Matt Canavan" || id.SlugBase != "matt-canavan" {
		t.Errorf("display %q slug %q, want the PREFERRED name", id.DisplayName, id.SlugBase)
	}
	// Middle names are deliberately NOT stored: aec_given_names_agree matches on
	// any token, so "Matthew James" would agree with a candidate named James.
	if id.GivenNames != "Matthew" {
		t.Errorf("given_names = %q, want just the first given name", id.GivenNames)
	}

	// No preferred name means no alias to seed — not an alias equal to the key.
	plain, ok := buildSenatorIdentity(handbookIndividual{
		PHID: "ZN4", FamilyName: "HENDERSON", GivenName: "Sarah", SenateState: "Victoria",
		MPorSenator: []string{"Senator"}, RepresentedParliaments: []int{48},
		PartyParliamentaryService: []handbookServiceInterval{service("2025-07-01", today)},
	})
	if !ok {
		t.Fatal("identity withheld")
	}
	if plain.PreferredKey != "" {
		t.Errorf("preferred key = %q, want empty when the names agree", plain.PreferredKey)
	}
}

// The population filter: membership in a LIST, and a floor.
func TestSenatorSelectionFilter(t *testing.T) {
	pure := handbookIndividual{
		PHID: "A", FamilyName: "ONE", GivenName: "A", SenateState: "Tasmania",
		MPorSenator: []string{"Senator"}, RepresentedParliaments: []int{47},
		PartyParliamentaryService: []handbookServiceInterval{service("2022-07-01", today)},
	}
	dual := pure
	dual.PHID, dual.FamilyName = "B", "TWO"
	dual.MPorSenator = []string{"Member", "Senator"}
	member := pure
	member.PHID, member.FamilyName = "C", "THREE"
	member.MPorSenator = []string{"Member"}
	old := pure
	old.PHID, old.FamilyName = "D", "FOUR"
	old.RepresentedParliaments = []int{40, 41}
	old.PartyParliamentaryService = []handbookServiceInterval{service("2002-07-01", "2008-06-30")}

	got := selectSenators([]handbookIndividual{pure, dual, member, old})
	if len(got) != 2 {
		t.Fatalf("selected %d, want 2 (a member is not a senator; a pre-44 senator is below the floor)", len(got))
	}
}

// A dead heat on party WITHHOLDS. Naming one of two parties for a parliament a
// person crossed the floor in publishes a decision the source did not make.
func TestPartyTieWithholds(t *testing.T) {
	span, _ := parliamentSpan(47)
	h := handbookIndividual{
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", "2025-05-03",
				[3]string{"Party A", "2022-05-21", "2023-11-20"},
				[3]string{"Party B", "2023-11-20", "2025-05-03"}),
		},
	}
	// Two parties, unequal shares: the longer one is named.
	if party, _ := partyForSpan(h, span); party != "Party A" {
		t.Errorf("party = %q, want Party A (the longer share)", party)
	}

	mid := day("2022-05-21").Add(span.To.Sub(span.From) / 2).Format("2006-01-02")
	tie := handbookIndividual{
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", "2025-05-03",
				[3]string{"Party A", "2022-05-21", mid},
				[3]string{"Party B", mid, "2025-05-03"}),
		},
	}
	if party, _ := partyForSpan(tie, span); party != "" {
		t.Errorf("party = %q on a dead heat, want withheld", party)
	}
}

// The abbreviation may only be published beside the party it belongs to.
func TestPartyAbbrevIsNotAppliedToAHistoricalParty(t *testing.T) {
	span, _ := parliamentSpan(47)
	h := handbookIndividual{
		Party: "Independent", PartyAbbrev: "IND",
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", "2025-05-03",
				[3]string{"Pauline Hanson's One Nation", "2022-05-21", "2025-05-03"}),
		},
	}
	party, ab := partyForSpan(h, span)
	if party != "Pauline Hanson's One Nation" {
		t.Fatalf("party = %q", party)
	}
	if ab != "" {
		t.Errorf("abbrev = %q — IND describes their CURRENT party, not this one", ab)
	}
}

func TestSubtractIntervals(t *testing.T) {
	whole := dateInterval{From: day("2010-01-01"), To: day("2020-01-01")}
	got := subtractIntervals(whole, []dateInterval{
		{From: day("2012-01-01"), To: day("2014-01-01")},
		{From: day("2018-01-01"), To: day("2025-01-01")},
	})
	want := []dateInterval{
		{From: day("2010-01-01"), To: day("2012-01-01")},
		{From: day("2014-01-01"), To: day("2018-01-01")},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if !got[i].From.Equal(want[i].From) || !got[i].To.Equal(want[i].To) {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	// Fully covered leaves nothing.
	if rest := subtractIntervals(whole, []dateInterval{{From: day("2000-01-01"), To: day("2030-01-01")}}); len(rest) != 0 {
		t.Fatalf("a fully covered span left %v", rest)
	}
}

// The parliament map is what makes the subtraction exact. Its boundaries are
// election days, and they must match the ones the Handbook writes into its own
// House service records — 150 records start on 2016-07-02, 151 on 2019-05-18,
// 151 on 2022-05-21, 149 on 2025-05-03.
func TestParliamentSpansAreElectionDays(t *testing.T) {
	span44, ok := parliamentSpan(44)
	if !ok {
		t.Fatal("no span for the 44th")
	}
	if !span44.From.Equal(day("2013-09-07")) || !span44.To.Equal(day("2016-07-02")) {
		t.Errorf("44th = [%v, %v), want [2013-09-07, 2016-07-02)", span44.From, span44.To)
	}
	last, ok := parliamentSpan(lastMappedParliament)
	if !ok || !last.To.Equal(dateOpen) {
		t.Errorf("the current parliament must be open-ended, got %v", last.To)
	}
	if _, ok := parliamentSpan(lastMappedParliament + 1); ok {
		t.Error("an unmapped parliament must not produce a span — a guessed boundary is a wrong term")
	}
	// Every mapped parliament is contiguous with the next.
	for p := firstMappedParliament; p < lastMappedParliament; p++ {
		a, _ := parliamentSpan(p)
		b, _ := parliamentSpan(p + 1)
		if !a.To.Equal(b.From) {
			t.Errorf("parliament %d ends %v but %d starts %v — a gap loses service", p, a.To, p+1, b.From)
		}
	}
}

func TestStateCodesRoundTrip(t *testing.T) {
	for name, code := range senateStateCodes {
		if got := stateRegionName(code); len(got) == 0 || got == code {
			t.Errorf("stateRegionName(%q) = %q, want the full name of %q", code, got, name)
		}
	}
	// An unknown code passes through rather than becoming a wrong state.
	if got := stateRegionName("Grayndler"); got != "Grayndler" {
		t.Errorf("stateRegionName passed an unknown value through as %q", got)
	}
}

// F6. THE ABBREVIATION IS A KEY, AND TWO KEYS FOR ONE PARTY SPLIT IT.
//
// The palette, the party chips and the Algolia party facet all look a party up
// by `party_ab`. The Handbook writes PHON for Pauline Hanson's One Nation and ON
// for One Nation — the same party, in the same room — and it writes the AEC's
// re-registration qualifier into "UAP [2018]". Stored raw, One Nation was two
// buckets and six real historical parties rendered as a grey "Other".
func TestPartyAbbrevIsNormalisedToTheProductsCode(t *testing.T) {
	cases := []struct{ in, want string }{
		{"PHON", "ON"},         // same party, second code
		{"phon", "ON"},         // case is not a different party
		{"ON", "ON"},           // already canonical
		{"UAP [2018]", "UAP"},  // a re-registration qualifier, not an abbreviation
		{"UAP  [2013]", "UAP"}, // any qualifier, generically
		{"ALP", "ALP"},         // untouched
		{"", ""},               // nothing to normalise
		{"[2018]", "[2018]"},   // no abbreviation to keep: passed through, never emptied
	}
	for _, c := range cases {
		if got := normalisePartyAbbrev(c.in); got != c.want {
			t.Errorf("normalisePartyAbbrev(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The normalisation happens at MINT, where the term is written — not in a read
// path that some future consumer could bypass.
func TestPartyAbbrevIsNormalisedOnTheTermItself(t *testing.T) {
	span, _ := parliamentSpan(47)
	h := handbookIndividual{
		Party: "Pauline Hanson's One Nation", PartyAbbrev: "PHON",
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", "2025-05-03",
				[3]string{"Pauline Hanson's One Nation", "2022-05-21", "2025-05-03"}),
		},
	}
	party, ab := partyForSpan(h, span)
	// The NAME is APH's prose and is stored verbatim — ND forbids rewriting it.
	if party != "Pauline Hanson's One Nation" {
		t.Errorf("party name = %q, want it verbatim from the source", party)
	}
	if ab != "ON" {
		t.Errorf("party_ab = %q, want ON", ab)
	}
}

// F11. THE TRIPWIRE FOR THE CAREER-WIDE STATE.
//
// deriveSenateTerms stamps ONE state — the Handbook's single `SenateState` —
// on every term it writes, because there is no per-parliament state anywhere in
// the payload. That is correct for everyone in range today and wrong the moment
// somebody represents two states in the Senate. Rule 3c joins candidate returns
// on state_code, so a stale state would offer a whole state's declared money to
// somebody who was never on its ballot: the ambiguous case WITHHOLDS the code
// rather than picking one, and this test is what fails if the withhold is ever
// removed.
func TestSenateStateWithheldWhenACareerSpansTwoSenateStates(t *testing.T) {
	// The live shape this must NOT fire on: Barnaby Joyce reads
	// ['NSW', 'Qld'] because New England is a HOUSE seat. One Senate state.
	joyce := handbookIndividual{
		SenateState:       "Queensland",
		RepresentedStates: []string{"NSW", "Qld"},
		ElectorateService: []handbookElectorateTerm{
			{Electorate: "New England", State: "New South Wales",
				ServiceStart: "2013-09-07", ServiceEnd: today},
		},
	}
	if senateStatesAmbiguous(joyce) {
		t.Error("a dual-chamber career must not read its HOUSE state as a second Senate state")
	}

	// The case the field cannot describe: two states, neither of them a House
	// seat. Nobody in range today; the guard exists for the day there is.
	twoStates := handbookIndividual{
		SenateState:       "Queensland",
		RepresentedStates: []string{"Qld", "NSW"},
	}
	if !senateStatesAmbiguous(twoStates) {
		t.Fatal("two Senate states must be detected as ambiguous")
	}

	terms := deriveSenateTerms(handbookIndividual{
		SenateState:            "Queensland",
		RepresentedStates:      []string{"Qld", "NSW"},
		RepresentedParliaments: []int{47, 48},
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", today),
		},
	})
	if len(terms) == 0 {
		t.Fatal("the fixture produced no terms to check")
	}
	for _, term := range terms {
		if term.StateCode != "" {
			t.Errorf("parliament %d carries state %q — an ambiguous state must be withheld, not guessed",
				term.Parliament, term.StateCode)
		}
	}
}

// The state IS written for everybody else — the guard must not be a blanket.
func TestSenateStateIsWrittenWhenItIsUnambiguous(t *testing.T) {
	terms := deriveSenateTerms(handbookIndividual{
		SenateState:            "Queensland",
		RepresentedStates:      []string{"Qld"},
		RepresentedParliaments: []int{47, 48},
		PartyParliamentaryService: []handbookServiceInterval{
			service("2022-05-21", today),
		},
	})
	if len(terms) == 0 {
		t.Fatal("no terms derived")
	}
	for _, term := range terms {
		if term.StateCode != "QLD" {
			t.Errorf("parliament %d state = %q, want QLD", term.Parliament, term.StateCode)
		}
	}
}
