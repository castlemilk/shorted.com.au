package influence

// Resolves declared item-1 text to ASX codes.
//
// EDITORIAL (docs/influence-editorial-standards.md §2): fuzzy name matches are
// analyst-only and never public. Only three things reach a public surface —
// a human-curated alias, an ASX ticker the member wrote themselves, or an exact
// normalised name match against exactly one company. The CHECK constraint on
// register_item_securities enforces that even if a query here is wrong.
//
// The splitting work is mostly already done: the parser preserves the cell's
// physical lines, and the form lists one entity per line. What remains is
// rejecting prose, stripping qualifiers, and the match ladder.

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// tickerInTextRe finds a parenthesised ASX-code-shaped token, e.g.
// "iShares S&P 500 ETF (IVV)" or "Betashares … Cash ETF (AAA)".
//
// ASX codes are 3 letters, sometimes with 1-2 trailing digits (A200, NDQ).
var tickerInTextRe = regexp.MustCompile(`\(([A-Z]{3}[A-Z0-9]{0,2})\)`)

// trailingTickerRe catches the un-parenthesised form: "Telstra TLS".
var trailingTickerRe = regexp.MustCompile(`\s([A-Z]{3}[A-Z0-9]{0,2})$`)

// tickerStopwords are generic security-type words that happen to BE real ASX
// codes, so a name ending in one would resolve to the wrong listing entirely.
//
// This was a live wrong-attribution bug, not a hypothetical: ETF is UBS IQ MSCI
// Australia ETF, and every fund name ending in "ETF" — "Betashares Global
// Sustainability Leaders ETF", "Australian Shares ETF" — resolved to it. Ten
// members were shown holding a fund none of them had declared. REIT (VanEck
// International REIT) and LIC (Lifestyle Communities) are the same trap.
//
// A member who genuinely holds one of these can be given a curated alias, which
// is checked first.
// Gift / travel / membership vocabulary, and bare years. These are ITEM 11-12
// content, never a listing. Anchored whole-string so a real company whose name
// merely contains one of these words is untouched ("Gift Holdings Ltd" survives).
var nonSecurityRe = regexp.MustCompile(
	`(?i)^\s*(` +
		`gifts?|hampers?|memberships?|subscriptions?|donations?|` +
		`flight\s+upgrades?|upgrades?|lounge(\s+(access|membership))?|` +
		`tickets?|complimentary\s+.*|hospitality|accommodation|` +
		`travel(\s+(costs?|expenses?))?|airfares?|sponsored\s+travel|flights?|` +
		`\d{4}|n/?a|nil|none|not\s+applicable|various|as\s+above|same\s+as\s+above` +
		`)\s*$`,
)

// A HOLDER LABEL that escaped the form's label column and became a candidate in
// its own right. The form's three holder rows are Self / Spouse-Partner /
// Dependent Children, and when the label bleeds into the value column the label
// itself gets declared as a thing the member owns.
//
// Anchored whole-string so a real company whose NAME contains one of these words
// is untouched by construction — "Turnbull & Partners Pty Limited", "Save the
// Children" and "Slater & Gordon Limited" all survive. The leading/trailing \W*
// is load-bearing: the observed rows are "spouse)" and "Spouse/Partner:", whose
// punctuation makeCandidate's Trim(".,;") does not remove.
//
// This is not cosmetic. "SELF" is a REAL ASX code (SelfWealth SMSF Leaders ETF),
// so the ticker path resolved it and published a FABRICATED shareholding in a
// real ETF against a named member.
//
// Deliberately NOT applied outside items 1/3/4: Barnaby Joyce's 45P item-12 row
// is a base statement whose declared value genuinely is the word "Partner".
var holderLabelRe = regexp.MustCompile(
	`(?i)^\W*(self|spouses?|partners?|spouse\s*/?\s*partner|` +
		`dependent(\s+child(ren)?)?|child(ren)?)\W*$`,
)

// The WHOLE candidate is an ASX-shaped code. ASX codes are 3 letters, with a few
// 2- and 4-character exceptions; anchored so it can never fire on a phrase.
var bareTickerRe = regexp.MustCompile(`^([A-Z0-9]{2,4})$`)

// An AMENDMENT NOTICE: the member instructing the registrar to remove, or
// recording that they sold or resigned. It is a real declaration — of a CHANGE —
// but it is not a thing that is held, and the fold has no way to know that, so it
// opened an interval and published the negation as a CURRENT interest.
//
// Measured verbatim, every one of these was live with currently_declared=true:
//
//	"please remove Listed Companies: VTG"          -> published as a live VTG link
//	"Remove reference to Westpac (partner)."
//	"Delete Branyan Investments Pty Ltd for self and spouse"  -> a current DIRECTORSHIP
//	"Resignation as Director and Secretary of Firebeam Pty Ltd"
//	"Sale of all AOG (AVEO Group) shares owned by self and husband ... on Monday"
//	"Disposal of her shareholding in Scintilla Strategic Investments Limited"
//
// Rejecting them withholds a past-tense fact. Publishing them asserts the exact
// OPPOSITE of what the member wrote, against a named person, so the asymmetry
// rule decides it. Rendering them properly needs change_type on the read path;
// see docs/feature/politicians/architecture.md §8.17.
var amendmentNoticeRe = regexp.MustCompile(
	`(?i)^\s*(please\s+remove|remove|delete|deletion\s+of|sale\s+of|sold|` +
		`disposal\s+of|disposed\s+of|resignation\s+as|i\s+resigned|resigned|` +
		`ceased|no\s+longer)\b`,
)

// A gift/travel LOG LINE, which items 11-12 are full of and which leaks into the
// item-1 candidate pool. Measured examples:
//
//	"14/11/17 Business Lunch with Bill Shorten Hyatt Regency Sydney"
//	"$50.00. 13 June"
//	"10 x tickets to attend the NAISDA Academy Mid-year Show"
//	"120 pack of Baby Mum-Mum Crackers - approx. value $360"
//
// They start with a date or a currency amount, or describe a quantity of a thing
// that is not shares. None is a security, and all of them sat in the resolution
// denominator as "unmatched".
var giftLogRe = regexp.MustCompile(
	`(?i)^\s*(\d{1,2}/\d{1,2}/\d{2,4}|\$\s?[\d,]|\d+\s*(x|pack|bottles?|cases?)\s)`,
)

// GIFT / HOSPITALITY PROSE that leaks from items 11-12 into the item-1 pool.
//
// This is not cosmetic tidying — it was publishing WRONG COMPANIES against named
// members, because an organisation's acronym is often also a real ASX code:
//
//	Anthony Albanese  "pin and a football from the NRL"            -> NRL, Newland Resources
//	Peter Dutton      "Tickets ... State of Origin 3 NRL"          -> NRL   (National Rugby League)
//	Steve Irons       "ROD STEWART CONCERT TICKETS HOSTED BY RAC"  -> RAC   (Royal Automobile Club)
//	Steve Irons       "2 Tickets to AFL match ... hosted by WCE"   -> WCE   (West Coast Eagles)
//	M. McCormack      "2 x tickets to the New Year's Test at SCG"  -> SCG   (Sydney Cricket Ground)
//	Sharon Claydon    "Friends of the ABC"                         -> ABC   (the broadcaster)
//	Craig Laundy      "2 Tickets to the Women's Open from NAB"     -> NAB   (a real bank, but a GIFT)
//
// A stopword list cannot fix this: NRL, AFL, ARU, RAC, SCG, WCE and ABC are all
// live ASX codes, so blocking them would also block a member who genuinely holds
// one. The reliable signal is that the CELL is hospitality prose, not a holding.
//
// Measured over the whole corpus: rejects 14 currently-'resolved' rows and every
// one of the 14 is a wrong fact. No genuine holding matches.
//
// DELIBERATELY EXCLUDES a bare "flight": "FLT" is Flight Centre Travel Group and
// appears inside real SMSF share lists. Only the phrase "flight upgrade" is a
// gift marker.
// A CELL CARRYING A SPECIFIC CALENDAR DATE is an event log, not a holdings list.
//
// This is the STRUCTURAL version of giftProseRe, added because the vocabulary was
// extended three times for the same defect and still missed a variant:
//
//	"Qantas, Flight upgrade, 16 March 2018, Cairns-Sydney"   caught by vocabulary
//	"Nine Entertainment Co, Dinner, November 19 2013"        caught on the 2nd pass
//	"Virgin Australia, Flight Transfer, 26 June 2015"        MISSED by both
//
// "Flight Transfer" is not "upgrade" and never will be — there is always another
// noun. What every one of them has and a shareholdings cell does not is a date:
// a member declaring BHP writes "BHP Group Ltd", not "BHP Group Ltd, 16 March 2018".
//
// Measured over all 1,181 resolved item-1/4 rows on prod: exactly 2 come from a
// cell containing a month-name date, and both are the Flight Transfer wrong facts.
// ZERO false positives. A numeric date is already handled at fragment level by
// giftLogRe.
var cellHasCalendarDateRe = regexp.MustCompile(
	`(?i)\b(\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}` +
		`|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b`,
)

var giftProseRe = regexp.MustCompile(
	`(?i)\b(tickets?|hospitality|courtesy\s+of|hosted\s+by|guest\s+of|` +
		`invitation|corporate\s+box|grand\s+final|state\s+of\s+origin|` +
		`test\s+match|concert|christmas\s+ham|football|pin\s+and|` +
		// Added after the audit: the cell-level test found five MORE wrong facts
		// that the narrower vocabulary missed. `dinner` not `gala dinner`
		// ("Nine Entertainment Co, Dinner, November 19 2013" -> NEC) and bare
		// `upgrade` not `flight upgrade` ("Upgrade, Melbourne to LA, Qantas" ->
		// QAN; "Complimentary on departure upgrade to Business Class, Virgin
		// Australia" -> VGN).
		//
		// Measured over items 1 and 4 before widening: these four words kill 5
		// resolved rows and ALL FIVE are wrong facts — every one a flight upgrade
		// or a dinner published as a shareholding. Zero genuine holdings lost.
		`dinner|lunch|complimentary|upgrade)\b`,
)

// A quantity prefix on a REAL holding: "1000 SHARES IN KWINANA COMMUNITY
// FINANCIAL SERVICES LTD". Stripping it is what lets the company name match —
// rejecting the row on length instead would silently drop a genuine declaration.
var sharesInPrefixRe = regexp.MustCompile(`(?i)^\s*[\d,]+\s+(?:ordinary\s+)?shares?\s+in\s+`)

var tickerStopwords = map[string]bool{
	"ETF": true, "REIT": true, "LIC": true, "FUND": true, "TRUST": true,
	"LTD": true, "INC": true, "PLC": true, "PTY": true, "SMSF": true,
	"AUD": true, "USD": true, "NIL": true, "ORD": true, "FPO": true,
	"SHARES": true, "UNITS": true, "GROUP": true, "BANK": true,
	// Words that are not securities but ARE live ASX codes, so the ticker path
	// would resolve them against a named person. USA is UraniumSA and SELF is
	// the SelfWealth SMSF Leaders ETF — SELF published a fabricated ETF holding
	// for a member whose form simply had the holder label in the wrong column.
	// ACN/ABN precede a company number; the states appear in ordinary company
	// names. ALC is deliberately absent: "Alcidion Group Ltd (ALC)" resolves
	// legitimately on 3 rows.
	"USA": true, "SELF": true, "SPOUSE": true, "ACN": true, "ABN": true,
	"QLD": true, "NSW": true, "VIC": true, "TAS": true, "ACT": true, "NZL": true,
	// Ordinary English and administrative words that are also live ASX codes.
	// Measured: a bare token scan over vehicle-chipped candidates matched 149
	// rows and the top hits were AND(42), FOR(20), ACN(15), SELF(13), ONE(13),
	// ICE(12) — "Venice Ice Pty Limited", "Van Manen Investments". They must not
	// count as a member stating a ticker, NOR as evidence that a cell is about
	// securities.
	"AND": true, "FOR": true, "ONE": true, "TWO": true, "ALL": true, "ARE": true,
	"HAS": true, "CAN": true, "ICE": true, "VAN": true, "JAY": true, "HUB": true,
	"DEV": true, "DNA": true, "EMU": true, "ZIP": true, "AUST": true,
	"HOME": true, "CASH": true, "LAND": true, "SUPER": true,
}

// qualifierRe strips declaration bookkeeping that is not part of a name.
var qualifierRe = regexp.MustCompile(`(?i)\s*\((joint|joint with spouse|jointly|self|spouse|partner|shared|disposed[^)]*|acquired[^)]*|formerly[^)]*)\)`)

// securitySuffixRe strips share-class notation: "Far Ltd FPO" is FAR.
var securitySuffixRe = regexp.MustCompile(`(?i)\s+(FPO|FPS|CDI|STAPLED|ORD|ORDINARY)\.?$`)

// privateCompanyRe marks a line as an unlisted private entity. Its presence
// vetoes the inline-ticker path: "Gunnedah Industries (NW) Pty Ltd" must never
// resolve to a listed code that happens to share those letters.
//
// It is the UNION of the three markers below and stays a single expression so
// the veto behaviour is byte-for-byte what it always was. The markers exist only
// to say WHICH kind of private entity it is (entityKindOf); they never gate a
// match. entity_kind_union_test.go asserts the union holds.
var privateCompanyRe = regexp.MustCompile(`(?i)\bp(?:ty|/l)\b|\bproprietary\b|\bfamily trust\b|\bsuperannuation fund\b|\bsmsf\b`)

// The three arms of privateCompanyRe, named. A declaration routinely trips more
// than one — "Kenley Dale Pty Ltd (trustee of self-managed superannuation fund)"
// matches the Pty arm AND the super arm — so entityKindOf tests them
// most-specific first: the VEHICLE is what a reader wants named, and a Pty Ltd
// that exists only to be a super fund's trustee is editorially an SMSF.
var (
	smsfMarkerRe           = regexp.MustCompile(`(?i)\bsuperannuation fund\b|\bsmsf\b`)
	familyTrustMarkerRe    = regexp.MustCompile(`(?i)\bfamily trust\b`)
	privateCompanyMarkerRe = regexp.MustCompile(`(?i)\bp(?:ty|/l)\b|\bproprietary\b`)
)

// Entity kinds. Mirrors register_item_securities_entity_kind_check
// (000098, extended by 000099).
const (
	entityKindListed         = "listed"
	entityKindPrivateCompany = "private_company"
	entityKindFamilyTrust    = "family_trust"
	entityKindSMSF           = "smsf"
	entityKindManagedFund    = "managed_fund"
	entityKindForeign        = "foreign"
	entityKindNotAnEntity    = "not_an_entity"
	entityKindMultiEntity    = "multi_entity"
)

// ---------------------------------------------------------------------------
// Multi-entity detection
// ---------------------------------------------------------------------------

// A candidate that names MORE THAN ONE entity cannot be truthfully labelled with
// any single one of them. That is the §8.16 blocker: a cell naming a real ASX
// listing alongside a super fund was chipped "Self-managed super fund", whose
// tooltip says "these are not on the ASX, so there is no ticker" — so the label
// actively DENIED the shareholding it was hiding, against a named member.
//
// Splitting these was tried and rejected. Every splitter measured either failed
// to recover the listing (abbreviationTail refuses "Santos Ltd. Held", by design
// and correctly — "Pty. Ltd." must not split) or manufactured NEW wrong facts:
// a Ltd-run boundary turns "Astra … Ltd Citigroup (USA)" into a standalone
// "Citigroup (USA)", which resolves USA to UraniumSA and publishes a live wrong
// link. See docs/feature/politicians/architecture.md §8.17.
//
// So these are WITHHELD, not relabelled and not split. It costs 16 candidate
// rows of 5,881 published (0.27%); publishing a label that contradicts the
// declaration beneath it is not a cost we are allowed to pay.
var (
	// The member wrote the word themselves: a "Listed Companies:" heading
	// inside the cell, or a foreign-exchange annotation.
	multiListedHeadingRe = regexp.MustCompile(`(?i)listed\s+compan`)
	multiForeignListedRe = regexp.MustCompile(`(?i)\b(uk|us|nyse|nasdaq|lse)\s+listed\b`)
	multiPlcRe           = regexp.MustCompile(`(?i)\bplc\b`)
	// An (a)/(b)/(c) enumerator: the member is listing groups within one cell.
	// Requires the opening paren, so a bare "a)" list does not qualify — those
	// are caught by the suffix count below.
	multiEnumeratorRe = regexp.MustCompile(`\([a-c]\)\s`)
	// Corporate-suffix arithmetic. MORE public-company suffixes than
	// private-company ones means at least one named entity is not the vehicle.
	//
	// This is a RATIO, not a count, and the distinction is load-bearing:
	// "Growth Farms Pty Ltd (via Gufee Pty Ltd)" is 2 Ltd / 2 Pty and stays
	// published as the private company it is. Requiring only ">=2 Ltd" was
	// measured and would have withheld 47 correctly-labelled private-company
	// rows (Angus Taylor's holdings, Ken O'Dowd's three companies) for no
	// safety gain.
	ltdSuffixRe = regexp.MustCompile(`(?i)\b(ltd|limited)\b`)
	ptySuffixRe = regexp.MustCompile(`(?i)(\bpty\b|\bp/l\b|\bproprietary\b)`)
	// A validated ticker whose adjacent parenthetical names the same company:
	// "AOG (AVEO Group)". Self-corroborating, so it needs no stopword list —
	// unlike a bare token scan, which measured 14.5% precision because ACN,
	// ICE, RHT and VAN are all real ASX codes and all appear inside ordinary
	// private-company names.
	tickerGlossRe = regexp.MustCompile(`\b([A-Z]{3}[A-Z0-9]{0,2})\s*\(([^)]{3,40})\)`)
)

// namesMoreThanOneEntity reports whether the candidate text names several
// entities. `codes` may be nil, which disables only the ticker-gloss arm.
func namesMoreThanOneEntity(raw string, codes map[string]string) bool {
	switch {
	case multiListedHeadingRe.MatchString(raw),
		multiForeignListedRe.MatchString(raw),
		multiPlcRe.MatchString(raw),
		multiEnumeratorRe.MatchString(raw):
		return true
	case len(ltdSuffixRe.FindAllString(raw, -1)) > len(ptySuffixRe.FindAllString(raw, -1)):
		return true
	}

	for _, m := range tickerGlossRe.FindAllStringSubmatch(raw, -1) {
		listing, ok := codes[strings.ToUpper(m[1])]
		if !ok {
			continue
		}
		upperListing := strings.ToUpper(listing)
		for _, word := range strings.FieldsFunc(strings.ToUpper(m[2]), func(r rune) bool {
			return !('A' <= r && r <= 'Z') && !('0' <= r && r <= '9')
		}) {
			// >3 characters so "THE", "PTY" and "AND" cannot corroborate.
			if len(word) > 3 && strings.Contains(upperListing, word) {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Cell context
// ---------------------------------------------------------------------------

// A SHAREHOLDINGS CELL LOOKS DIFFERENT FROM A GIFT LOG, and the document tells
// us which one we are reading. Judging each fragment in isolation is what forced
// the string-by-string vocabularies above; the cell it came from is far stronger
// evidence than any keyword list.
//
// Measured over item 1: cells carrying a company signal hold 2,551 candidates
// and produce 1,077 resolutions (42%). Cells carrying NONE hold 2,501 candidates
// and produce 108 (4.3%) — a tenfold difference. A read of 30 random unresolved
// candidates from the no-signal cells found: "Bunch of flowers", "Small pewter
// mug", "battery operated candle", "BBC branded laptop sleeve", "Extra Virgin
// Olive Oil Soap x 2", "Book: Blue Flames", "Upgrade economy to business class
// Melbourne to Brisbane", "Approximate value $60.", "Westpac Business One
// Account", "Potts Point". Exactly one named a security, and it was Meta — a
// NASDAQ listing, correctly unresolvable here.
//
// Those rows are not missing aliases. They are gifts, travel, bank accounts and
// prose that the 44P/45P scans filed under item 1, and today every one of them
// renders on a named member's profile as "— not matched to an ASX listing".
//
// SAFETY: the signal only ever reclassifies a candidate that FAILED to resolve.
// A candidate that matched an alias, a stated ticker or a listing name keeps its
// resolution and stays 'listed', so the 108 real resolutions in no-signal cells
// are preserved exactly. This removes padding from the denominator; it cannot
// remove a match.
var cellCompanyShapeRe = regexp.MustCompile(
	`(?i)(\b(ltd|limited|group|holdings|plc|nl|corporation|corp|company|bank|` +
		`resources|mining|energy|industries|pty|proprietary|trust|fund|etf|reit|` +
		// `shares?` not `shares`: "Unilife Share Sold" missed by one letter.
		// `bank(ing)?`: "Commonwealth Banking of Australia" missed on \\bbank\\b.
		`shares?|securities|portfolio|equities|banking|` +
		// Fund issuers: a cell reading "VAS Vanguard" or "Betashares A200"
		// carries no corporate suffix at all but is unmistakably a holdings list.
		`vanguard|betashares|ishares|vaneck|spdr|macquarie|colonial|blackrock|` +
		`bhp|telstra|woodside)\b|\bp/l\b)`,
)

// cellHasSecuritySignal reports whether ANY candidate in the cell looks like a
// security, so the cell as a whole can be read as a shareholdings list.
//
// `codes` may be nil, which disables only the bare-ticker arm — a cell written
// as "BHP, CBA, TLS" carries no corporate suffix at all and would otherwise look
// signal-less.
func cellHasSecuritySignal(candidates []SecurityCandidate, codes map[string]string) bool {
	for _, c := range candidates {
		if c.Ticker != "" {
			return true
		}
		if cellCompanyShapeRe.MatchString(c.Raw) {
			return true
		}
		if codes == nil {
			continue
		}
		if _, ok := codes[strings.ToUpper(strings.TrimSpace(c.Raw))]; ok {
			return true
		}
		// A VALIDATED ASX CODE ANYWHERE IN THE TEXT is a signal, wherever it sits.
		//
		// An independent audit found 28 genuine declarations deleted from the
		// denominator because the code was in a LEADING or mid-string position
		// that no ticker path reads: "IVV - self and spouse" (Karen Andrews),
		// "FMG Fortescue" / "JBH JB HiFi" / "WES Wesfarmers" (Tom Venning),
		// "CBA (Jointly held with spouse)", "ORI", "S32", "WPL" (Helen Haines),
		// "APT- After Pay Touch", "SYD- Sydney Airport Staple" (Barnaby Joyce).
		// Every one of those states a real code and was being silently withheld.
		//
		// Using a token scan HERE is safe where using it to RESOLVE is not: this
		// only decides whether the cell stays in the denominator and keeps
		// publishing. A false positive costs an unmatched row in the count — the
		// conservative direction — never a wrong company. The stopword list keeps
		// AND/FOR/ONE/ICE from firing.
		for _, tok := range strings.FieldsFunc(c.Raw, func(r rune) bool {
			return !('A' <= r && r <= 'Z') && !('0' <= r && r <= '9')
		}) {
			if len(tok) < 2 || len(tok) > 4 || tickerStopwords[tok] {
				continue
			}
			if _, ok := codes[tok]; ok {
				return true
			}
		}
	}
	return false
}

// entityKindOf names WHAT a candidate is, from discriminators that were already
// computed. It is plumbing, not a new classifier: every branch reads either the
// resolution the ladder already reached or a regexp that already ran.
//
// entityKindForeign is declared and permitted by the CHECK but is never returned
// here. The only available signal would be an Inc/LLC/plc suffix, and in this
// corpus four of the fourteen such names are Australian incorporated
// associations ("Street Law Centre (WA) Inc."). Calling those a foreign listing
// would be a wrong fact about a named person's directorship, so 'foreign' waits
// for a curated decision rather than a suffix guess.
func entityKindOf(c SecurityCandidate, status string) string {
	switch {
	case status == "unlisted_fund":
		// A curated human decision: real declaration, not an ASX listing.
		return entityKindManagedFund
	case c.Reject != "":
		// nonSecurityRe / giftLogRe / proseRe / the length rules. None of these
		// describes a thing that is held.
		return entityKindNotAnEntity
	case status == "resolved":
		// It matched a listing, so it IS one, whatever suffix it carries.
		return entityKindListed
	case c.MultiEntity && privateCompanyRe.MatchString(c.Raw):
		// About to be labelled a vehicle, but the text names more than one
		// entity — so no single chip is true, and the vehicle chip is the one
		// that would actively deny a listing named beside it. Scoped to the
		// vehicle branches on purpose: a multi-entity string with no vehicle
		// marker falls through to 'listed', which claims nothing false.
		return entityKindMultiEntity
	case smsfMarkerRe.MatchString(c.Raw):
		return entityKindSMSF
	case familyTrustMarkerRe.MatchString(c.Raw):
		return entityKindFamilyTrust
	case privateCompanyMarkerRe.MatchString(c.Raw):
		return entityKindPrivateCompany
	case status == "not_a_security":
		// The remaining way to reach not_a_security is a curated alias whose
		// resolution says so — the 'noise' seeds in 000097 ("APPLICABLE",
		// "SEE ATTACHED", "LTD"). A human already decided these name nothing.
		return entityKindNotAnEntity
	case status == "unmatched" && c.ItemNo == 1 && !c.CellHasSecuritySignal:
		// Nothing in this cell looks like a security, and this candidate did not
		// resolve — so the cell is a gift log, a travel log or prose that was
		// filed under item 1, not a shareholdings list. Calling it a listing we
		// failed to match would be a claim about a match attempt that never
		// meaningfully happened, and it publishes "Bunch of flowers" as a
		// company interest.
		//
		// ITEM 1 ONLY. Item 4 (directorships) is overwhelmingly unlisted bodies
		// by nature — "Art Gallery Society of NSW", a school board, a charity —
		// and §8.15 decided deliberately that those ARE real declared interests
		// worth publishing. Applying a shareholdings-shaped test to them would
		// withhold the very rows that change was made to surface.
		return entityKindNotAnEntity
	default:
		// A plausible listing we have not matched. This is the ONLY case the
		// "not matched to an ASX listing" wording was ever written for.
		return entityKindListed
	}
}

// A candidate that names a FAMILY MEMBER rather than a company. Members write
// the relation into the cell, and the splitter turns it into a candidate that
// then renders on the profile as a declared company interest:
//
//	"daughter Poppy Hunt and son James Hunt"   <- a member's MINOR CHILDREN
//	"wife Louise Howarth."
//	"My wife has been employed by Valspar Group Pty Ltd."
//
// Editorial standards §4 puts private individuals and family members out of
// scope, and naming a child as a company interest is wrong twice over.
//
// "child" is DELIBERATELY ABSENT from the alternation. It is an ordinary word in
// Australian company names — "Child Psych Corp Pty Ltd" and "Bald Hills Child
// Care P/L" are real declared private companies, and "Save the Children" is a
// real directorship. The relation words kept here do not appear at the START of
// any company name in this corpus.
var personReferenceRe = regexp.MustCompile(
	`(?i)^\s*(my\s+)?(wife|husband|daughter|son|mother|father|brother|sister|` +
		`step-?son|step-?daughter|partner's)\b`,
)

// proseRe marks a line as narrative rather than an entity name. Members write
// sentences into the cell, and the parser preserves them faithfully:
// "On the 19th of August 2025 I ceased" / "to be a shareholder of Gunnedah".
var proseRe = regexp.MustCompile(`(?i)\b(i (?:ceased|acquired|sold|hold|purchased|disposed)|shareholder of|no longer|as (?:at|per)|see (?:attached|above|below)|refer to|all (?:spouse|partner|details)|nil return|not applicable)\b`)

// maxCandidateLen rejects prose that slipped past proseRe. The longest real ASX
// company name is well under this.
const maxCandidateLen = 120

// SecurityCandidate is one entity name teased out of a declared cell.
type SecurityCandidate struct {
	Ordinal int
	Raw     string
	Norm    string
	Wide    string // Norm under the register-scoped widened normalisation
	Ticker  string // an ASX code the member stated themselves
	Private bool   // an unlisted private entity (Pty Ltd, family trust, SMSF)
	Reject  string // non-empty => not a security; carries the reason
	// MultiEntity: the text names more than one entity, so no single label is
	// true of it. Set by resolveSecurityCandidate, which has the listings map
	// the ticker-gloss arm needs.
	MultiEntity bool
	// CellHasSecuritySignal: some candidate in the SAME cell looks like a
	// security, so this cell can be read as a shareholdings list at all. Set by
	// the caller, which is the only place that can see a candidate's siblings.
	CellHasSecuritySignal bool
	// CellText is the WHOLE declared cell this fragment came from. Needed because
	// splitFragments cuts on commas, so the evidence that a cell is a gift log
	// usually sits in a DIFFERENT fragment than the company name:
	// "Qantas, Flight upgrade, 16 March 2018, Cairns-Sydney" yields a bare
	// "Qantas", which resolved to QAN and published a flight upgrade as David
	// Coleman's current shareholding.
	CellText string
	// ItemNo is the form item this candidate was declared under. The cell-signal
	// rule is scoped to item 1; see entityKindOf.
	ItemNo int
}

// splitSecurityBlob turns a declared item-1 cell into ordered candidates.
//
// declared_lines is the primary split, because the form puts one entity per
// line. Each line is then sub-split on separators, which is where the source
// gets messy: it mixes commas AND periods, e.g.
//
//	"ANZ, Arena REIT, Beta shares Asia ETF, BHP. CBA, Cochlear, CSL."
//
// so "BHP. CBA" is two companies while "Pty. Ltd." is not a boundary.
func splitSecurityBlob(lines []string, fallback string) []SecurityCandidate {
	source := lines
	if len(source) == 0 && strings.TrimSpace(fallback) != "" {
		source = []string{fallback}
	}

	// The WHOLE cell, for the checks that cannot be made on a fragment.
	cell := strings.TrimSpace(strings.Join(source, " "))
	if cell == "" {
		cell = strings.TrimSpace(fallback)
	}
	// A HOSPITALITY CELL POISONS EVERY FRAGMENT IN IT. splitFragments cuts on
	// commas, so the company name and the evidence that it was a gift land in
	// different fragments: "Qantas, Flight upgrade, 16 March 2018,
	// Cairns-Sydney" yields a bare "Qantas". Judged per fragment, that resolved
	// to QAN and published a flight upgrade as a member's CURRENT shareholding —
	// verified live on prod for David Coleman (QAN, VGN x3, NEC), Greg Hunt
	// (QAN, VGN), Julian Hill (VGN) and Nick Champion (VGN).
	// Two tests, one vocabulary and one structural. The structural one is why the
	// vocabulary no longer has to be exhaustive.
	cellIsGiftProse := giftProseRe.MatchString(cell) || cellHasCalendarDateRe.MatchString(cell)

	var out []SecurityCandidate
	for _, line := range source {
		for _, fragment := range splitFragments(line) {
			candidate := makeCandidate(len(out), fragment)
			if candidate.Raw == "" {
				continue
			}
			candidate.CellText = cell
			if cellIsGiftProse && candidate.Reject == "" {
				candidate.Reject = "gift_prose_cell"
			}
			out = append(out, candidate)
		}
	}
	return out
}

// sentenceBoundaryRe splits on a period ONLY when it is followed by whitespace
// and an uppercase letter, and the preceding token is not an abbreviation.
//
// Written without lookahead: Go's regexp is RE2, so `(?=[A-Z])` does not
// compile. The uppercase letter is therefore CONSUMED by the match and handed
// back to the next fragment by rewinding one byte (ASCII, so one byte is one
// letter).
var sentenceBoundaryRe = regexp.MustCompile(`\.\s+[A-Z]`)

// abbreviations must not be treated as a fragment boundary.
var abbreviationTail = regexp.MustCompile(`(?i)\b(ltd|limited|inc|co|pty|plc|nl|corp|no|st|pte|sa|nv|ag)\.$`)

func splitFragments(line string) []string {
	line = normaliseUnicode(line)
	if line == "" {
		return nil
	}

	// Commas, semicolons and newlines are unambiguous separators.
	rough := regexp.MustCompile(`[;,\n]+`).Split(line, -1)

	var out []string
	for _, part := range rough {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		// Now consider periods, keeping abbreviations intact.
		start := 0
		for _, loc := range sentenceBoundaryRe.FindAllStringIndex(part, -1) {
			head := strings.TrimSpace(part[start : loc[0]+1])
			if abbreviationTail.MatchString(head) {
				continue
			}
			if head != "" {
				out = append(out, head)
			}
			// Rewind one byte so the uppercase letter the pattern consumed
			// starts the next fragment: "BHP. CBA" must yield "CBA", not "BA".
			start = loc[1] - 1
		}
		if tail := strings.TrimSpace(part[start:]); tail != "" {
			out = append(out, tail)
		}
	}
	return out
}

func normaliseUnicode(s string) string {
	replacer := strings.NewReplacer(
		"–", "-", "—", "-", "‘", "'", "’", "'",
		"“", `"`, "”", `"`, " ", " ",
	)
	return strings.Join(strings.Fields(replacer.Replace(s)), " ")
}

// selfGlossedAcronym reports whether a parenthesised code is simply the
// INITIALISM of the words before it — an organisation glossing its own name,
// not a member quoting a ticker.
//
// "Confederation of Indian Industry (CII) - Tie" published CII / Ci Resources as
// a shareholding; "World Trade Centre (WTC) India - Tie" published WTC. Both are
// gifts of a necktie from a trade body.
//
// Blocking the TICKER path here is safe precisely because it is not a rejection:
// the candidate falls through to the name path, so an organisation that IS a
// listed company still resolves by its name. Verified on the corpus —
// "Commonwealth Bank of Australia (CBA)" still reaches CBA and "Insurance
// Australia Group (IAG)" still reaches IAG, while the two trade bodies match
// nothing, which is the correct answer for them.
func selfGlossedAcronym(raw, code string) bool {
	open := strings.Index(raw, "("+code+")")
	if open <= 0 {
		return false
	}
	var initials strings.Builder
	for _, word := range strings.Fields(raw[:open]) {
		cleaned := strings.Map(func(r rune) rune {
			if ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') {
				return r
			}
			return -1
		}, word)
		if cleaned == "" {
			continue
		}
		// Skip the joining words an initialism conventionally drops.
		switch strings.ToUpper(cleaned) {
		case "OF", "THE", "AND", "FOR", "A":
			continue
		}
		initials.WriteString(strings.ToUpper(cleaned[:1]))
	}
	return initials.String() == strings.ToUpper(code)
}

func makeCandidate(ordinal int, fragment string) SecurityCandidate {
	c := SecurityCandidate{Ordinal: ordinal, Raw: strings.TrimSpace(fragment)}
	if c.Raw == "" {
		return c
	}

	// An inline ticker is captured BEFORE qualifiers are stripped, but only when
	// the line is not an unlisted private entity.
	private := privateCompanyRe.MatchString(c.Raw)
	c.Private = private
	// A parenthesised acronym that is merely the initialism of the words before
	// it gets STRIPPED rather than trusted, so the name underneath gets a clean
	// run at the name matcher. Leaving "(CBA)" in place would normalise to
	// "COMMONWEALTH BANK OF AUSTRALIA CBA", which matches no listing — blocking
	// the ticker path without stripping would lose a real holding.
	selfGloss := ""
	if !private {
		if m := tickerInTextRe.FindStringSubmatch(c.Raw); m != nil && !tickerStopwords[m[1]] {
			if selfGlossedAcronym(c.Raw, m[1]) {
				selfGloss = "(" + m[1] + ")"
			} else {
				c.Ticker = m[1]
			}
		}
	}

	// Strip a leading share-quantity BEFORE anything else, so the company name
	// underneath gets a fair chance at every matcher.
	base := sharesInPrefixRe.ReplaceAllString(c.Raw, "")
	if selfGloss != "" {
		base = strings.TrimSpace(strings.Replace(base, selfGloss, "", 1))
	}

	cleaned := qualifierRe.ReplaceAllString(base, "")
	cleaned = securitySuffixRe.ReplaceAllString(strings.TrimSpace(cleaned), "")
	cleaned = strings.TrimSpace(strings.Trim(cleaned, ".,;"))

	// A candidate that is NOTHING BUT a ticker never matched, because
	// trailingTickerRe only fires on a ticker FOLLOWING other text. Members
	// routinely write the code alone — "IAG", "QBE", "TLS" — and those then fell
	// through to name matching, which cannot work: the listing is "Insurance
	// Australia Group", not "IAG". Measured after the 44P/45P backfill, bare
	// tickers were the single largest group in the item-1 unmatched pool.
	//
	// Safe because resolveSecurityCandidate only accepts a ticker that EXISTS in
	// the listings map, so a 3-letter word that is not a real code still misses.
	//
	// The private veto is deliberately NOT applied to these two arms. A member
	// who writes "Superannuation Fund - Listed Companies: VCX" has stated the
	// code themselves, and vetoing it published the row under an SMSF chip with
	// the shareholding invisible. Measured over the whole corpus, lifting the
	// veto here resolves exactly 5 rows — MLB, TNE and VCX x3 — all genuine, no
	// false positives, alone or combined with any splitter.
	//
	// It stays on tickerInTextRe above, because the PARENTHESISED arm fires on
	// exactly one vehicle row and that row is wrong: "… Citigroup (USA)" would
	// publish a live link to USA / UraniumSA.
	if c.Ticker == "" {
		if m := bareTickerRe.FindStringSubmatch(cleaned); m != nil && !tickerStopwords[m[1]] {
			c.Ticker = m[1]
		}
	}

	if c.Ticker == "" {
		if m := trailingTickerRe.FindStringSubmatch(cleaned); m != nil && !tickerStopwords[m[1]] {
			c.Ticker = m[1]
			cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, m[1]))
		}
	}

	switch {
	case amendmentNoticeRe.MatchString(c.Raw):
		// An instruction to the registrar, or a disposal. Publishing it as a
		// holding asserts the opposite of what the member wrote.
		c.Reject = "amendment_notice"
	case holderLabelRe.MatchString(cleaned):
		c.Reject = "holder_label"
	case personReferenceRe.MatchString(c.Raw):
		c.Reject = "person_reference"
	case giftLogRe.MatchString(c.Raw):
		c.Reject = "gift_log_line"
	case giftProseRe.MatchString(c.Raw):
		// Hospitality prose, not a holding. Must be tested BEFORE any ticker is
		// trusted: the acronym at the end of "…courtesy of NRL" is a real code.
		c.Reject = "gift_prose"
	case nonSecurityRe.MatchString(cleaned):
		// Items 11 and 12 (gifts, sponsored travel) go through the same splitter
		// as item 1, so their content lands in the candidate pool. Measured after
		// the 44P/45P backfill, the top "unmatched" names were GIFT, 2017,
		// FLIGHT UPGRADE and MEMBERSHIP — none of them a security, all of them in
		// the denominator, dragging the item-1 resolution rate from 35.3% to
		// 20.3% without a single extra failure. Older parliaments carry far more
		// gift/travel text, so widening the corpus diluted the metric rather than
		// worsening it. These belong OUTSIDE the denominator, which is what
		// `resolvable = candidates - not_a_security` exists for.
		c.Reject = "not_a_security_term"
	case proseRe.MatchString(c.Raw):
		c.Reject = "prose"
	case len(c.Raw) > maxCandidateLen:
		c.Reject = "too_long"
	case len(strings.TrimSpace(cleaned)) < 2 && c.Ticker == "":
		c.Reject = "too_short"
	}

	c.Norm = normalizeEntityName(cleaned)
	c.Wide = widenEntityName(cleaned)
	if c.Norm == "" && c.Ticker == "" && c.Reject == "" {
		c.Reject = "empty_after_normalisation"
	}
	return c
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Register-scoped widened normalisation
// ---------------------------------------------------------------------------
//
// A SECOND, more aggressive normalisation, applied only on the register path.
//
// It is deliberately NOT a change to normalizeEntityName/normExpr, which are
// shared with the lobbyist and corporate-tax matchers (runMatch). Widening those
// would silently re-key every one of their mappings; this layers on top instead,
// and is consulted only after the strict name match has already missed.
//
// What it adds, each taken from a measured miss in this corpus:
//
//	leading "THE"          "The Lottery Corporation" vs "Lottery Corporation"
//	" AND " -> " "         "Bendigo and Adelaide Bank" vs "Bendigo Adelaide Bank"
//	digit joining          "SOUTH 32" -> "SOUTH32"
//	a wider suffix list    GRP/CORP/NL/INC/CO/REIT/FPO/UNITS/STAPLED/ORDINARY/LLC
//	trailing quantity noun "Telstra shares" -> "Telstra"
//
// SAFETY: it is applied to BOTH sides — the candidate AND the listing name — and
// a widened name that maps to more than one listing is DROPPED, exactly as the
// strict map drops ambiguous names. So it can only ever add a match that is
// unique under the wider key; it can never pick between two companies.
var (
	widenedSuffixRe  = regexp.MustCompile(`(?i)\s+(LIMITED|LTD|GROUP|GRP|HOLDINGS|CORPORATION|CORP|COMPANY|PLC|NL|INC|CO|TRUST|PTY|PROPRIETARY|REIT|FPO|UNITS|STAPLED|ORDINARY|ORD|LLC)\.?$`)
	widenedLeadingRe = regexp.MustCompile(`(?i)^THE\s+`)
	widenedAndRe     = regexp.MustCompile(`(?i)\s+AND\s+`)
	widenedTailNoun  = regexp.MustCompile(`(?i)\s+(SHARES?|STOCK|SECURITIES|SHAREHOLDINGS?)$`)
	widenedDigitJoin = regexp.MustCompile(`([A-Z])\s+(\d+)$`)
	widenedNonAlnum  = regexp.MustCompile(`[^A-Z0-9]+`)
)

func widenEntityName(s string) string {
	out := strings.ToUpper(strings.TrimSpace(s))
	out = strings.TrimSpace(widenedNonAlnum.ReplaceAllString(out, " "))
	out = widenedLeadingRe.ReplaceAllString(out, "")
	out = widenedAndRe.ReplaceAllString(out, " ")
	// Strip repeatedly: "Vanguard Australian Shares Index Fund Ltd Ord" needs
	// more than one pass, same reason normalizeEntityName strips twice.
	for range 3 {
		out = strings.TrimSpace(widenedSuffixRe.ReplaceAllString(out, ""))
		out = strings.TrimSpace(widenedTailNoun.ReplaceAllString(out, ""))
	}
	out = widenedDigitJoin.ReplaceAllString(out, "$1$2")
	return strings.Join(strings.Fields(out), " ")
}

// loadWidenedCompanyNames builds the widened map IN GO from the same listings
// the strict map is built from, so the two normalisations can never drift the
// way a hand-mirrored SQL expression would. Names that widen onto more than one
// listing are dropped.
func loadWidenedCompanyNames(ctx context.Context, pool *pgxpool.Pool) (map[string]CompanyNameMapping, error) {
	rows, err := pool.Query(ctx, `
		SELECT stock_code, company_name, COALESCE(NULLIF(industry, ''), 'Unclassified')
		FROM "company-metadata"
		WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		  AND stock_code IS NOT NULL AND btrim(stock_code) <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type entry struct {
		mapping CompanyNameMapping
		codes   map[string]bool
	}
	staged := map[string]*entry{}
	for rows.Next() {
		var code, name, industry string
		if err := rows.Scan(&code, &name, &industry); err != nil {
			return nil, err
		}
		key := widenEntityName(name)
		if len(key) < 4 {
			// Too short to be a safe key: "AGL", "CSL" would collide with the
			// ticker namespace and with each other.
			continue
		}
		e, ok := staged[key]
		if !ok {
			e = &entry{
				mapping: CompanyNameMapping{StockCode: code, CompanyName: name, Industry: industry},
				codes:   map[string]bool{},
			}
			staged[key] = e
		}
		e.codes[strings.ToUpper(code)] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := map[string]CompanyNameMapping{}
	for key, e := range staged {
		if len(e.codes) == 1 {
			out[key] = e.mapping
		}
	}
	return out, nil
}

// SecurityAlias is a curated declared-name -> code decision.
type SecurityAlias struct {
	StockCode   string
	AliasKind   string
	Resolution  string
	DisplayName string
}

// SecurityResolution is the outcome for one candidate.
type SecurityResolution struct {
	StockCode      string
	CompanyName    string
	Status         string
	MatchMethod    string
	Confidence     float64
	CandidateCount int
	// EntityKind names WHAT the candidate is. Set by resolveSecurityCandidate
	// so callers cannot forget it; see entityKindOf.
	EntityKind string
}

func loadRegisterSecurityAliases(ctx context.Context, pool *pgxpool.Pool) (map[string]SecurityAlias, error) {
	rows, err := pool.Query(ctx, `
		SELECT alias_norm, COALESCE(stock_code, ''), alias_kind, resolution, display_name
		FROM register_security_aliases`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]SecurityAlias{}
	for rows.Next() {
		var norm string
		var a SecurityAlias
		if err := rows.Scan(&norm, &a.StockCode, &a.AliasKind, &a.Resolution, &a.DisplayName); err != nil {
			return nil, err
		}
		out[norm] = a
	}
	return out, rows.Err()
}

// loadAmbiguousCompanyNames returns normalised names that map to MORE than one
// listing, with the count.
//
// collapseCompanyNameMappings deliberately drops those names, so without this a
// same-name trap is indistinguishable from a name we simply do not carry — and
// the curation backlog would invite someone to "fix" it with an alias guess
// instead of a human decision.
func loadAmbiguousCompanyNames(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx, `
		SELECT `+normExpr("company_name")+` AS nname, count(DISTINCT stock_code) AS codes
		FROM "company-metadata"
		WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		  AND stock_code IS NOT NULL AND btrim(stock_code) <> ''
		GROUP BY 1
		HAVING count(DISTINCT stock_code) > 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var name string
		var n int
		if err := rows.Scan(&name, &n); err != nil {
			return nil, err
		}
		if name != "" {
			out[name] = n
		}
	}
	return out, rows.Err()
}

// loadStockCodes is the validation set for an inline ticker. A code the member
// wrote is only trusted once it is confirmed to be a real listing.
func loadStockCodes(ctx context.Context, pool *pgxpool.Pool) (map[string]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT upper(stock_code), COALESCE(company_name, '')
		FROM "company-metadata"
		WHERE stock_code IS NOT NULL AND stock_code <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var code, name string
		if err := rows.Scan(&code, &name); err != nil {
			return nil, err
		}
		out[code] = name
	}
	return out, rows.Err()
}

// resolveSecurityCandidate applies the ladder in precedence order.
//
//  1. curated alias — a human decision outranks a coincidence
//  2. inline ticker  — the member stated the code; validated against listings
//  3. exact normalised name — one company or nothing, same rule as runMatch
//
// Anything else is unmatched or ambiguous, and neither is publishable.
func resolveSecurityCandidate(
	c SecurityCandidate,
	aliases map[string]SecurityAlias,
	codes map[string]string,
	names map[string]CompanyNameMapping,
	ambiguous map[string]int,
	wide map[string]CompanyNameMapping,
) SecurityResolution {
	c.MultiEntity = namesMoreThanOneEntity(c.Raw, codes)
	res := resolveSecurityStatus(c, aliases, codes, names, ambiguous, wide)
	// entityKindOf derives the kind from the status the ladder reached. A curated
	// alias may already have PINNED a kind that no status can express (see the
	// 'foreign' branch above); deriving over the top of it would discard the
	// human decision and relabel a foreign listing as naming nothing.
	if res.EntityKind == "" {
		res.EntityKind = entityKindOf(c, res.Status)
	}
	return res
}

func resolveSecurityStatus(
	c SecurityCandidate,
	aliases map[string]SecurityAlias,
	codes map[string]string,
	names map[string]CompanyNameMapping,
	ambiguous map[string]int,
	wide map[string]CompanyNameMapping,
) SecurityResolution {
	if c.Reject != "" {
		return SecurityResolution{Status: "not_a_security"}
	}

	if alias, ok := aliases[c.Norm]; ok {
		switch alias.Resolution {
		case "resolved":
			return SecurityResolution{
				StockCode: alias.StockCode, CompanyName: alias.DisplayName,
				Status: "resolved", MatchMethod: "curated_alias", Confidence: 1.0,
			}
		case "unlisted_fund":
			return SecurityResolution{Status: "unlisted_fund", MatchMethod: "curated_alias"}
		case "foreign":
			// A foreign listing IS a security — it is simply not one we can link,
			// so it must leave the ASX-resolution denominator while keeping an
			// honest label. entityKindOf deliberately never GUESSES this from an
			// Inc/LLC/plc suffix (four of the fourteen such names in this corpus
			// are Australian incorporated associations), so a human saying so is
			// the only way the label is ever true. Pinned here rather than derived
			// from Status, because the status it shares — not_a_security — is also
			// how "names nothing at all" is spelled.
			return SecurityResolution{
				Status: "not_a_security", MatchMethod: "curated_alias",
				EntityKind: entityKindForeign,
			}
		default:
			return SecurityResolution{Status: "not_a_security", MatchMethod: "curated_alias"}
		}
	}

	if c.Ticker != "" {
		if name, ok := codes[strings.ToUpper(c.Ticker)]; ok {
			return SecurityResolution{
				StockCode: strings.ToUpper(c.Ticker), CompanyName: name,
				Status: "resolved", MatchMethod: "ticker_in_text", Confidence: 1.0,
			}
		}
	}

	// A "Pty Ltd" / family trust / SMSF that matched nothing is not a listing we
	// failed to find — it is not a listed security at all. Classifying it as
	// unmatched buries the real curation work: 171 of a 607-row item-1 backlog
	// were private entities, and item 4 (directorships) is almost entirely them.
	// A curated alias and a member-stated ticker still win, because both are
	// checked first — those are human or member decisions, not coincidences.
	//
	// THIS MUST STAY ABOVE THE NAME MATCH. normalizeEntityName strips " LTD" and
	// then " PTY", so a private company collapses onto a listing's name by
	// coincidence: "Endeavour Pty Ltd" -> ENDEAVOUR matched Endeavour Group and
	// published a live /shorts/EDV link against a member's spouse's private
	// company. Exactly one row corpus-wide, and exactly one wrong fact.
	// "Metrics Master Income Trust" -> MXT is unaffected: privateCompanyRe wants
	// a FAMILY trust, not a bare one.
	if c.Private {
		return SecurityResolution{Status: "not_a_security"}
	}

	if mapping, ok := names[c.Norm]; ok {
		return SecurityResolution{
			StockCode: mapping.StockCode, CompanyName: mapping.CompanyName,
			Status: "resolved", MatchMethod: "name_exact", Confidence: 1.0,
		}
	}

	// The widened key, tried only once the strict key has missed. Still
	// name_exact: both sides go through the SAME deterministic function and a
	// widened name matching more than one listing was dropped when the map was
	// built, so this is an exact match on a wider key — never a fuzzy one, and
	// never a choice between two companies.
	if c.Wide != "" && len(c.Wide) >= 4 {
		if mapping, ok := wide[c.Wide]; ok {
			return SecurityResolution{
				StockCode: mapping.StockCode, CompanyName: mapping.CompanyName,
				Status: "resolved", MatchMethod: "name_exact", Confidence: 1.0,
			}
		}
	}

	// collapseCompanyNameMappings drops names that resolve to more than one
	// listing, so a same-name trap arrives here as a miss. Recording it as
	// 'ambiguous' rather than 'unmatched' keeps the curation backlog honest:
	// these need a human decision, not a new alias guess.
	if count, ok := ambiguous[c.Norm]; ok {
		return SecurityResolution{Status: "ambiguous", CandidateCount: count}
	}

	return SecurityResolution{Status: "unmatched"}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type securityResolveStats struct {
	Candidates  int
	Resolved    int
	Ambiguous   int
	Unmatched   int
	NotSecurity int
	Unlisted    int
	ByMethod    map[string]int
	// ByKind is the honest denominator source: only entity_kind='listed'
	// candidates can ever carry a ticker, so only they belong in the gate.
	ByKind map[string]int
	// Item1Listed / Item1Resolved are the GATE's real numbers.
	//
	// The headline used to divide by items 1 AND 4 while calling itself "item-1
	// security resolution". §3.4 says in terms that item 4 must not sit in the
	// headline denominator: directorships are overwhelmingly private companies
	// and resolve at ~1%, so including them understates the metric by ~2.7pt and
	// measures something nobody intended. Item 4 is still resolved and still
	// published — it just is not the gate.
	Item1Listed   int
	Item1Resolved int
}

// runRegisterSecurityResolve rebuilds the auto-derived rows in one transaction,
// preserving analyst-only curation — the same posture as runMatch.
func runRegisterSecurityResolve(ctx context.Context, pool *pgxpool.Pool) (securityResolveStats, error) {
	stats := securityResolveStats{ByMethod: map[string]int{}, ByKind: map[string]int{}}

	aliases, err := loadRegisterSecurityAliases(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load aliases: %w", err)
	}
	codes, err := loadStockCodes(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load stock codes: %w", err)
	}
	names, err := loadCompanyNameMappings(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load company names: %w", err)
	}
	ambiguous, err := loadAmbiguousCompanyNames(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load ambiguous names: %w", err)
	}
	wide, err := loadWidenedCompanyNames(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load widened names: %w", err)
	}

	type declaredRow struct {
		ID     string
		ItemNo int
		Text   string
		Lines  []string
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, item_no, declared_text, declared_lines
		FROM register_declared_items
		WHERE item_no IN (1, 4) AND NOT is_nil`)
	if err != nil {
		return stats, err
	}
	var items []declaredRow
	for rows.Next() {
		var r declaredRow
		if err := rows.Scan(&r.ID, &r.ItemNo, &r.Text, &r.Lines); err != nil {
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

	// Rebuild auto rows; never touch analyst curation.
	if _, err := tx.Exec(ctx, `
		DELETE FROM register_item_securities
		WHERE match_method IS DISTINCT FROM 'analyst_fuzzy'`); err != nil {
		return stats, err
	}

	batch := &pgx.Batch{}
	queued := 0
	for _, item := range items {
		cellCandidates := splitSecurityBlob(item.Lines, item.Text)
		cellSignal := cellHasSecuritySignal(cellCandidates, codes)
		for _, c := range cellCandidates {
			c.CellHasSecuritySignal = cellSignal
			c.ItemNo = item.ItemNo
			res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, wide)
			stats.Candidates++
			stats.ByKind[res.EntityKind]++
			if item.ItemNo == 1 {
				if res.EntityKind == entityKindListed {
					stats.Item1Listed++
				}
				if res.Status == "resolved" {
					stats.Item1Resolved++
				}
			}
			switch res.Status {
			case "resolved":
				stats.Resolved++
				stats.ByMethod[res.MatchMethod]++
			case "ambiguous":
				stats.Ambiguous++
			case "unmatched":
				stats.Unmatched++
			case "unlisted_fund":
				stats.Unlisted++
			default:
				stats.NotSecurity++
			}

			var method any
			if res.MatchMethod != "" {
				method = res.MatchMethod
			}
			var code any
			if res.StockCode != "" {
				code = res.StockCode
			}
			batch.Queue(`
				INSERT INTO register_item_securities
					(item_id, candidate_ordinal, candidate_raw, candidate_norm,
					 stock_code, company_name, resolution_status, match_method,
					 confidence, candidate_count, entity_kind)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				ON CONFLICT (item_id, candidate_ordinal) DO UPDATE SET
					candidate_raw     = EXCLUDED.candidate_raw,
					candidate_norm    = EXCLUDED.candidate_norm,
					stock_code        = EXCLUDED.stock_code,
					company_name      = EXCLUDED.company_name,
					resolution_status = EXCLUDED.resolution_status,
					match_method      = EXCLUDED.match_method,
					confidence        = EXCLUDED.confidence,
					candidate_count   = EXCLUDED.candidate_count,
					entity_kind       = EXCLUDED.entity_kind,
					resolved_at       = now()`,
				item.ID, c.Ordinal, c.Raw, c.Norm, code, res.CompanyName,
				res.Status, method, res.Confidence, res.CandidateCount, res.EntityKind)
			queued++
		}
	}

	if queued > 0 {
		br := tx.SendBatch(ctx, batch)
		for range queued {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return stats, fmt.Errorf("insert security candidate: %w", err)
			}
		}
		if err := br.Close(); err != nil {
			return stats, err
		}
	}

	return stats, tx.Commit(ctx)
}
