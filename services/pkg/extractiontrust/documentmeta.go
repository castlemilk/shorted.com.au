package extractiontrust

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// DocumentMeta is financial_report_extractions.document_meta (contract 2.5):
// what the extractor read deterministically from the document itself. Every
// field is optional; an empty string means absent. JSON tags are exactly the
// contract's keys.
type DocumentMeta struct {
	// Currency is the presentation currency, ISO 4217 upper case.
	Currency string `json:"currency,omitempty"`
	// CurrencyEvidence is the verbatim text the currency was read from.
	CurrencyEvidence string `json:"currency_evidence,omitempty"`
	// Units is units | thousands | millions | billions, set only when exactly
	// one distinct unit statement is found in the pages read.
	Units string `json:"units,omitempty"`
	// UnitsEvidence is the verbatim text the units were read from.
	UnitsEvidence string `json:"units_evidence,omitempty"`
	// Entity is the reporting entity's name as the document states it.
	Entity string `json:"entity,omitempty"`
	// ABN is the Australian Business Number, "NN NNN NNN NNN".
	ABN string `json:"abn,omitempty"`
	// PeriodEnd is the document's own period end, YYYY-MM-DD.
	PeriodEnd string `json:"period_end,omitempty"`
	// PeriodType is annual | half.
	PeriodType string `json:"period_type,omitempty"`
	// ReportKind is appendix_4e | appendix_4d | annual_report |
	// half_year_report | results_announcement | other.
	ReportKind string `json:"report_kind,omitempty"`
}

// Closed vocabularies of DocumentMeta (contract 2.5).
const (
	UnitsUnits     = "units"
	UnitsThousands = "thousands"
	UnitsMillions  = "millions"
	UnitsBillions  = "billions"

	PeriodTypeAnnual = "annual"
	PeriodTypeHalf   = "half"

	ReportKindAppendix4E          = "appendix_4e"
	ReportKindAppendix4D          = "appendix_4d"
	ReportKindAnnualReport        = "annual_report"
	ReportKindHalfYearReport      = "half_year_report"
	ReportKindResultsAnnouncement = "results_announcement"
	ReportKindOther               = "other"
)

var unitsMultiplier = map[string]float64{
	UnitsUnits:     1,
	UnitsThousands: 1e3,
	UnitsMillions:  1e6,
	UnitsBillions:  1e9,
}

var periodTypes = map[string]bool{PeriodTypeAnnual: true, PeriodTypeHalf: true}

var reportKinds = map[string]bool{
	ReportKindAppendix4E:          true,
	ReportKindAppendix4D:          true,
	ReportKindAnnualReport:        true,
	ReportKindHalfYearReport:      true,
	ReportKindResultsAnnouncement: true,
	ReportKindOther:               true,
}

// iso4217 is the active ISO 4217 currency code list (fund and precious-metal
// codes excluded). Membership, not just the three-letter shape, is required.
var iso4217 = func() map[string]bool {
	const codes = `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD
BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK
DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF
IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP
LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN
NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR
SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD
TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG`
	m := map[string]bool{}
	for c := range strings.FieldsSeq(codes) {
		m[c] = true
	}
	return m
}()

// abnRE is the canonical ABN spelling the extractor emits.
var abnRE = regexp.MustCompile(`^\d{2} \d{3} \d{3} \d{3}$`)

// maxFreeTextRunes caps entity and evidence strings: a longer capture is a
// runaway regex, not evidence.
const maxFreeTextRunes = 200

// ParseDocumentMeta decodes a document_meta JSONB value, treating every
// out-of-vocabulary or malformed field as absent:
//
//   - currency must be an active ISO 4217 code, upper case;
//   - units, period_type and report_kind must be in their closed vocabularies
//     (exact, lower case);
//   - period_end must be a real calendar date spelled YYYY-MM-DD;
//   - abn must be spelled "NN NNN NNN NNN" and pass the ABN checksum;
//   - entity and the evidence strings must be non-blank and at most 200
//     characters, and entity is reduced by cleanEntity to the name it states
//     (absent when it states none);
//   - currency_evidence / units_evidence are dropped when their value is
//     absent (evidence for nothing is not kept);
//   - a non-string value (a number, null, an object) is absent; unknown keys
//     are ignored.
//
// Empty input or JSON null is the zero value with no error; input that is not a
// JSON object is an error (the caller treats the row as having no meta).
func ParseDocumentMeta(raw []byte) (DocumentMeta, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return DocumentMeta{}, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return DocumentMeta{}, fmt.Errorf("extractiontrust: document_meta is not a JSON object: %w", err)
	}
	str := func(key string) string {
		v, ok := fields[key]
		if !ok {
			return ""
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return ""
		}
		return s
	}

	var m DocumentMeta
	if c := str("currency"); iso4217[c] {
		m.Currency = c
		m.CurrencyEvidence = freeText(str("currency_evidence"))
	}
	if u := str("units"); unitsMultiplier[u] != 0 {
		m.Units = u
		m.UnitsEvidence = freeText(str("units_evidence"))
	}
	m.Entity = cleanEntity(freeText(str("entity")))
	if a := str("abn"); ValidABN(a) {
		m.ABN = a
	}
	if p := str("period_end"); validISODate(p) {
		m.PeriodEnd = p
	}
	if p := str("period_type"); periodTypes[p] {
		m.PeriodType = p
	}
	if k := str("report_kind"); reportKinds[k] {
		m.ReportKind = k
	}
	return m, nil
}

// IsZero reports whether no field survived validation.
func (m DocumentMeta) IsZero() bool { return m == DocumentMeta{} }

// UnitsMultiplier is the scale Units denotes (1, 1e3, 1e6, 1e9); false when
// Units is absent.
func (m DocumentMeta) UnitsMultiplier() (float64, bool) {
	f, ok := unitsMultiplier[m.Units]
	return f, ok
}

// PeriodEndDate is PeriodEnd as a UTC date; false when absent.
func (m DocumentMeta) PeriodEndDate() (time.Time, bool) {
	if m.PeriodEnd == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.DateOnly, m.PeriodEnd)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// ValidABN reports whether s is an ABN in the canonical "NN NNN NNN NNN"
// spelling with a valid checksum (subtract 1 from the first digit, weight the
// digits 10, 1, 3, 5, ..., 19; the sum is a multiple of 89).
func ValidABN(s string) bool {
	if !abnRE.MatchString(s) {
		return false
	}
	digits := strings.ReplaceAll(s, " ", "")
	if digits[0] == '0' {
		return false // ABNs start at 10; a leading 0 would weight -1
	}
	weights := [11]int{10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19}
	sum := 0
	for i := range 11 {
		d := int(digits[i] - '0')
		if i == 0 {
			d--
		}
		sum += d * weights[i]
	}
	return sum%89 == 0
}

func validISODate(s string) bool {
	if len(s) != len(time.DateOnly) {
		return false
	}
	t, err := time.Parse(time.DateOnly, s)
	return err == nil && t.Format(time.DateOnly) == s
}

func freeText(s string) string {
	if strings.TrimSpace(s) == "" || utf8.RuneCountInString(s) > maxFreeTextRunes {
		return ""
	}
	return s
}

// cleanEntity reduces a stated entity to the name it states, or "" when it
// states none: services/report-extractor/document_meta.py clean_entity, rule
// for rule, applied here to every stored entity so a row written before a rule
// existed reads the way a new one is written (the shared fixture's "entities"
// pins both). Measured on prod 2026-10-11, 16 of the 74 entities that failed
// EntityMatches were not names, or a name run into an address.
//
// A letterhead is cut at its first separator ("Klevo Group Ltd |Suite 102,
// ..."), a registration-number tail and a leading "Name:" or "of" are
// dropped; "The Responsible Entity of X is Y" is the scheme X, or Y when X is
// only "the Scheme"; "The directors of Y" is Y; a sentence's tail is cut away
// ("... the portfolio. RAM Property Funds Management Limited"), and so are
// trailing parentheticals, except a former name ("(formerly X)", "(previously
// known as X)", "(Formerly: X)"), which stays after the name unless that is a
// Pty Ltd's (or Proprietary Limited's); a value that starts with a former name,
// behind a "Name:" or "of" too, states no name, whatever follows it. What is
// left is dropped when it is not a name (notANameREs). The name of another
// organisation (an auditor, a responsible entity) is kept: it says the document
// may not be the company's, and EntityMatches then withholds it.
func cleanEntity(s string) string {
	for _, sep := range []string{"|", "•"} {
		if i := strings.Index(s, sep); i >= 0 {
			s = s[:i]
		}
	}
	s = registrationTailRE.ReplaceAllString(strings.Join(strings.Fields(s), " "), "")
	if leadingFormerNameRE.MatchString(s) {
		return "" // "(formerly BPH Global Ltd), ": the trim below would leave "formerly ...)"
	}
	s = strings.Trim(s, entityTrimChars)
	s = leadingLabelRE.ReplaceAllString(s, "")
	if leadingFormerNameRE.MatchString(s) {
		return "" // "Name: (formerly BPH Global Ltd) ...": the same, behind a label
	}
	if m := responsibleEntityOfRE.FindStringSubmatch(s); m != nil {
		if scheme := strings.Trim(m[1], entityTrimChars); genericSchemeRE.MatchString(scheme) {
			s = m[2]
		} else {
			s = leadingTheRE.ReplaceAllString(scheme, "")
		}
	}
	s = directorsOfRE.ReplaceAllString(s, "")
	if ends := sentenceEndRE.FindAllStringIndex(s, -1); len(ends) > 0 {
		s = s[ends[len(ends)-1][1]-1:]
	}
	former := ""
	for {
		paren := trailingParenRE.FindStringIndex(s)
		if paren == nil {
			break
		}
		if former == "" {
			if f := formerNameRE.FindStringIndex(s[paren[0]:]); f != nil && f[0] == 0 {
				former = strings.TrimSpace(s[paren[0]:])
			}
		}
		s = s[:paren[0]]
	}
	s = strings.Trim(s, entityTrimChars)
	if s == "" {
		return "" // nothing left, or only a former name: no name of its own
	}
	if r, _ := utf8.DecodeRuneInString(s); !unicode.IsLetter(r) && !unicode.IsDigit(r) {
		return ""
	}
	for _, re := range notANameREs {
		if re.MatchString(s) {
			return ""
		}
	}
	if former != "" && !proprietaryRE.MatchString(s) {
		s += " " + former
	}
	if utf8.RuneCountInString(s) > maxFreeTextRunes {
		return ""
	}
	return s
}

const entityTrimChars = " \t,;:-(. "

var (
	registrationTailRE = regexp.MustCompile(`[ \t,(]+\(?(?:ABN|ACN|ARSN|ARBN)\b.*$`)
	// A generic label or a connective before the name: AKG's "Name: Academies
	// Australasia Group Limited", CPU's notice of meeting ("The Annual General
	// Meeting / of Computershare Limited / ABN 71 005 485 825"). A role label
	// ("Trustee: Perpetual Trust Services Limited") is never stripped: the name
	// after it is another organisation's.
	leadingLabelRE        = regexp.MustCompile(`(?i)^(?:(?:company|entity)\s+)?name\s*:\s*|^of\s+`)
	responsibleEntityOfRE = regexp.MustCompile(`(?i)^the\s+responsible\s+entity\s+of\s+(.+?)\s+is\s+(.+)$`)
	genericSchemeRE       = regexp.MustCompile(`(?i)^(?:the\s+)?(?:registered\s+)?(?:scheme|fund|trust|company)$`)
	leadingTheRE          = regexp.MustCompile(`(?i)^the\s+`)
	directorsOfRE         = regexp.MustCompile(`(?i)^(?:the\s+)?directors\s+of\s+`)
	sentenceEndRE         = regexp.MustCompile(`[a-z]{4,}\.\s+[A-Z]`)
	trailingParenRE       = regexp.MustCompile(`\s*\([^()]*\)\s*$`)
	// ...except a former name: BP8's own FY26 annual report (idsId=03145583)
	// reads "Ocean Sciences Ltd (formerly BPH Global Ltd)" over "ABN 57 009 104
	// 330", and the company on record is still "Bph Global". Without the
	// bracket EntityMatches withheld the company's own report; with it the old
	// name or the new one matches. It is kept after the name, whatever other
	// trailing brackets are cut ("Altoro Metals Limited (ASX:ARO) (formerly
	// Variscan Mines Limited)" is "Altoro Metals Limited (formerly Variscan
	// Mines Limited)"), and with a colon too ("(Formerly: CHPT EX 3 Trust)",
	// CHC's control lost table).
	formerNameRE = regexp.MustCompile(`(?i)\s*\(\s*(?:formerly|previously)(?:\s+known\s+as)?(?:\s*:\s*|\s+)[^()\s][^()]*\)\s*$`)
	// A value that starts with a former-name bracket states no name, whatever
	// follows it, a label before it ("Name:", "of"), the trim's characters
	// ("- (formerly", ", (formerly") or a second bracket included. The trim
	// would leave the fragment "formerly BPH Global Ltd)", which EntityMatches
	// matches to Bph Global and withholds against Ocean Sciences, from
	// "(formerly BPH Global Ltd), ABN 57 009 104 330" under "Ocean Sciences
	// Ltd" (the ABN rule reads only the ABN's own line) or from "(formerly BPH
	// Global Ltd) (ASX: BP8)".
	leadingFormerNameRE = regexp.MustCompile(`(?i)^[\s,;:.(-]*\(\s*(?:formerly|previously)\b`)
	// ...but never after a proprietary company's name, short or long ("Pty
	// Ltd", "Pty. Limited", "Proprietary Limited"). A Pty Ltd is never the
	// listed entity, and its old name would lend it another company's words: a
	// subsidiary's own accounts as "Sturt Exploration Pty Ltd (formerly Axiant
	// Resources Exploration Pty Ltd)" would pass EntityMatches against Axiant
	// Resources, where AXR's filing of Sturt's accounts (idsId=03133576) is
	// withheld. The name is trimmed first, so a full stop after "Ltd" is gone.
	proprietaryRE = regexp.MustCompile(`(?i)\b(?:pty\.?|proprietary)\s*(?:ltd|limited)$`)
	// Not a name: a registration number or exchange code, a web or email
	// address, a street address or phone number (SWM's own FY25 Appendix 4E is
	// withheld on prod by the entity "T +61 2 8777 7777 /"), a legal form
	// alone, a form's label, a sentence about the release or the ASX's rules
	// ("Authorised for release by: the Board of Ampol Limited", "to the ASX
	// under Listing Rule 4.3A"), a document's own title, with or without its
	// year (BLG's annual report runs "ANNUAL FINANCIAL REPORT 2026  ABN 20 116
	// 825 793" along its pages, so the title was read as the entity before its
	// ABN).
	notANameREs = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^(?:abn|acn|arsn|arbn|asx)\b`),
		regexp.MustCompile(`(?i)www\.|https?:|@|\.com\b`),
		regexp.MustCompile(`(?i)\b(?:level|suite|unit|floor)\s+\d|\b\d+[a-z]?\s*/\s*\d+\s+[a-z]|\b(?:nsw|vic|qld|wa|sa|tas|act|nt|new\s+south\s+wales|victoria|queensland|western\s+australia|south\s+australia|tasmania|australian\s+capital\s+territory|northern\s+territory)[\s,]+\d{4}\b|\bt:\s*\+?\d`),
		regexp.MustCompile(`(?i)^(?:t|tel|telephone|ph|phone)\b[\s.:]*[+(]?\d`),
		regexp.MustCompile(`(?i)^(?:the\s+)?(?:company|limited|ltd|pty\.?\s*ltd|plc|inc|nl|corporation|group|holdings?)$`),
		regexp.MustCompile(`(?i)\bgroup\s+of\s+entities\b|\bname\s+of\s+entity\b|\bover\s+which\s+control\b`),
		regexp.MustCompile(`(?i)^authori[sz]ed\s+for\s+release\b|\blisting\s+rules?\b`),
		regexp.MustCompile(`(?i)^(?:(?:fy\s?)?(?:\d{2}){1,2}\s+)?(?:(?:annual|half[\s-]?year(?:ly)?|interim|preliminary\s+final|financial)\s+(?:financial\s+)?report|appendix\s*4[cde]|directors'?\s+report)(?:\s*-?\s*(?:(?:fy\s?)?(?:\d{2}){1,2}(?:[-/](?:\d{2}){1,2})?|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}))?$`),
	}
)
