package announcements

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// An issuer that lodges an estimate and never an update left its dividend
// unstored: rule 2 of dividendRowsFor drops estimated parts. Goodman Group
// (GMG) lodges one Appendix 3A.1 a half, two or three weeks before the period
// ends, and never an update (2024-06-19 to 2026-06-16); its notice of
// 2026-06-16 (03104557) estimates AUD 0.15, so GMG had no dividend rows at
// all. Its results document states the distribution the estimate names: the
// Appendix 4E 03127287, filed 2026-08-20 (the day the notice promised the
// actual amount), says "Final dividend and distribution proposed per GMG
// security (cents) 15.0".
//
// Parser 6 stores an estimate once the issuer's own results document confirms
// it, under every gate below. An adversarial review on prod data (2026-10-12)
// found matching on the amount alone unsafe: DXI's only "confirmation" was its
// 30 September quarter's 4.150, TOT matched four quarters' 0.75, and about 93
// of 365 results documents carry an entry for another distribution at another
// amount (BWP's interim 9.58 beside its final 9.83). The gates, in order:
//
//   - the notice: AUD, every part estimated and its franking stated (the API
//     serves no franking as 0%), a 2A.3 period end, a 3A.1a(i) (else
//     3B.1a(i)) due date, nothing paid in securities;
//   - the document: filed under the notice's own security code (never the
//     ordinary issuer a hybrid is listed under), a results document, a stated
//     period end equal to the notice's, filed on or after the due date and
//     within maxFilingLagDays of the period end, no other entity named, no
//     currency but AUD stated;
//   - the entry: trusted (extractiontrust.TrustedEntries), consensus "agree"
//     (the primary model and its checker; never "majority", "primary_only" or
//     a legacy entry with none), a label that names the notice's own
//     distribution and no other (distributionLabel), an amount per security
//     equal to the estimate as an exact decimal (extractiontrust
//     .PerSecurityAmount), franking that does not contradict the notice's;
//   - no contradiction: every agreed entry that names the distribution, in
//     every such document, states the estimate's amount.
//
// The pass adds what only the store knows (confirmEstimatedNotice): no later
// notice for the same dividend, and no row stored from a declared amount,
// under the estimate's ex-date or for its period under another. A later update
// under the same ex-date replaces a confirmed estimate; a confirmed estimate
// never replaces a declared row. An update lodged after the estimate was
// stored that also moves the ex-date is stored beside it (no prod estimate
// has had one: none of the 88 estimate-update pairs moved the ex-date).
//
// Accepted: an estimate that states 0% franking and is franked when paid
// (MOT's 03107254 was 3.00% franked) is stored at 0% when no entry says
// otherwise. GMG's estimate is the same shape: unfranked, and its 4E states no
// franked amount.

// confirmedEstimateMarker is in the attempt detail of a notice stored from its
// results document ("1 rows; estimate confirmed by <document URL>; actual
// amount due 2026-08-20"), which the data review lists.
const confirmedEstimateMarker = "estimate confirmed by"

// maxFilingLagDays bounds how long after the period end a confirming document
// may be filed. An Appendix 4E or 4D is due within two months and an annual
// report within three, four for some trusts; the latest document behind
// today's confirmations is GDI's annual report, 91 days after. Later than
// that, a document whose stated period end is a year before its own is the
// comparative year's: 13 results documents filed August to October 2026 state
// 2025-06-30 or earlier (CGS's "FY26 Appendix 4E" 03126159, VIT, CAM).
const maxFilingLagDays = 123

// ResultsDocument is one financial_report_extractions row as an estimate's
// confirmation reads it. The dividend class and document_meta are kept as
// stored and read only through extractiontrust.
type ResultsDocument struct {
	StockCode   string `json:"stock_code"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	CompanyName string `json:"company_name"` // "company-metadata".company_name of StockCode
	ReportDate  string `json:"report_date"`  // YYYY-MM-DD, the day it was filed; "" when not recorded
	// DocumentMeta is document_meta as stored; nil when NULL.
	DocumentMeta json.RawMessage `json:"document_meta"`
	// Dividend is metrics->'dividend' as stored; nil when the class is absent.
	Dividend json.RawMessage `json:"dividend"`
}

// EstimateMatch is the entry that confirms one estimated part.
type EstimateMatch struct {
	Type     string // the part's: ordinary or special
	Document string // the confirming document's URL
	Quote    string // the entry's source_text
}

// EstimateConfirmation is what ConfirmEstimate decided: the entry that
// confirms each estimated part, in part order, or why the estimate is not
// confirmed.
type EstimateConfirmation struct {
	Matches []EstimateMatch
	Reason  string // "" when confirmed
}

// Confirmed reports whether every estimated part has its confirming entry.
func (c EstimateConfirmation) Confirmed() bool { return c.Reason == "" && len(c.Matches) > 0 }

// Documents is every confirming document, in part order, each once.
func (c EstimateConfirmation) Documents() []string {
	var urls []string
	for _, m := range c.Matches {
		if !slices.Contains(urls, m.Document) {
			urls = append(urls, m.Document)
		}
	}
	return urls
}

// estimateConfirmable is why a notice's estimate cannot be confirmed by any
// document, or "" when a document may confirm it.
func estimateConfirmable(n DividendNotice) string {
	switch {
	case len(n.Parts) == 0:
		return "no dividend part"
	case n.Currency != "AUD":
		return "declared in " + n.Currency + ", not AUD"
	case n.PeriodEnd == "":
		return "no 2A.3 period end"
	case n.ActualDue == "":
		return "no date the actual amount is due"
	case n.Scrip > 0:
		return "part paid in securities"
	}
	for _, part := range n.Parts {
		switch {
		case !part.Estimated:
			return "a part is actual"
		case part.FrankedPct == nil:
			return "franking not stated (the API would serve it as 0%)"
		case part.Amount <= 0:
			return "no amount"
		}
	}
	return ""
}

// documentKind is what a document's own period is, for distributionLabel.
type documentKind int

const (
	periodUnknown documentKind = iota
	periodAnnual
	periodHalf
)

func documentKindOf(m extractiontrust.DocumentMeta) documentKind {
	annual := m.PeriodType == extractiontrust.PeriodTypeAnnual ||
		m.ReportKind == extractiontrust.ReportKindAppendix4E || m.ReportKind == extractiontrust.ReportKindAnnualReport
	half := m.PeriodType == extractiontrust.PeriodTypeHalf ||
		m.ReportKind == extractiontrust.ReportKindAppendix4D || m.ReportKind == extractiontrust.ReportKindHalfYearReport
	switch {
	case annual && !half:
		return periodAnnual
	case half && !annual:
		return periodHalf
	}
	return periodUnknown
}

// The label gate's vocabulary, matched against extractiontrust.Normalise of a
// quote (lower case, ASCII dashes, one space between words).
const monthNamesRE = `jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`

var (
	monthRE = regexp.MustCompile(`\b(?:` + monthNamesRE + `)\b`)
	// paymentDateRE is a payment date: "payable on 31 August 2026" (MGR),
	// "(paid on 26 February 2026)", "payment date 15/09/2026" (day first, as
	// ASX documents write it, also with dots or dashes: "26.08.2026",
	// "15-09-2026"), or a day and month with no year.
	paymentDateRE = regexp.MustCompile(`\b(?:paid|payable|payment)(?:\s+(?:on|date))?(?:\s*[:|])?\s*(?:(\d{1,2})\s+(` + monthNamesRE + `)(?:\s+(\d{4}))?|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}))\b`)
	// paymentMonthRE is a payment month, with or without a year ("Quarterly
	// dividend paid in June 2026", MEC's March quarter); paidDuringRE a
	// distribution paid during the period ("an interim dividend of 0.5 cents
	// per share was paid during the year", PAI).
	paymentMonthRE = regexp.MustCompile(`\b(?:paid|payable|payment)\s+(?:in|during)\s+(` + monthNamesRE + `)(?:\s+(\d{4}))?\b`)
	paidDuringRE   = regexp.MustCompile(`\b(?:paid|payable|payment)\s+during\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:year|period|half)\b`)
	// unplacedPaymentRE is a payment still in the quote once the dates above
	// are read. Whatever the words between, a month name or a four-digit year
	// in the 40 characters after a payment word is a date the rule could not
	// read: "paid to shareholders on 24 November 2025" (TBR 03146209), "paid
	// (24 March 2026)" (RMC 03130317), "to be paid on the 28 September 2026"
	// (SRH 03142911), "paid June 2026" (MEC's quote without "in"), "paid on
	// December 23, 2025", "paid 2026-03-20". (Four words instead of 40
	// characters reads the same on prod's entries, and misses "paid to
	// shareholders of the company on 24 June 2026".) So is a payment in or
	// during the year, period, half or quarter ("paid in the June quarter"); a
	// fiscal year or half ("paid during FY26", "paid in 1H-26", "paid in
	// F26"); an ordinal day ("paid on 23rd"); or a numeric date paymentDateRE
	// does not read ("paid 15/09/25" or "paid on the 24th"). It is read without
	// paidForRE's phrases, which say what was paid, not when ("Distribution
	// paid in respect of the June 2026 quarter"), and without the class of
	// security an amount is per when its period's own end follows it ("per
	// fully paid ordinary share for the year ended 30 June 2026",
	// classOfSecurity), so the 40 characters are counted without them.
	// Withheld, an own entry at another amount would no longer contradict the
	// estimate (ConfirmEstimate counts only the entries this gate passes).
	// Followed by any other date, the class's "paid" stays a payment word: "per
	// fully paid ordinary share on 24 June 2026", or "paid to the holders of
	// fully paid ordinary shares on 24 June 2026", is withheld. Not read: a
	// date before its payment word ("On 24 June 2026 the Company paid") or
	// after another verb ("distributed on"), so in the period end's month such
	// an earlier payment reads as the own distribution; nor a date run
	// together ("paid on 24June2026"), whose month is not read either, in any
	// month.
	unplacedPaymentRE = regexp.MustCompile(`\b(?:paid|payable|payment)\b.{0,40}?\b(?:(?:` + monthNamesRE + `)\b|(?:19|20)\d{2}\b)|` +
		`\b(?:paid|payable|payment)\s+(?:in|during)\s+(?:the\s+)?(?:[a-z0-9]+\s+){0,2}(?:year|period|half|quarter)\b|` +
		`\b(?:paid|payable|payment)\s+(?:on|date)(?:\s*[:|])?\s+the\s+\d{1,2}(?:st|nd|rd|th)\b|` +
		`\b(?:paid|payable|payment)(?:\s+(?:on|in|during|date))?(?:\s*[:|])?\s*(?:(?:[12]h\s*|h[12]\s*)?fy(?:\s*'?\d{2}|\b)|\bf\d{2}\b|` +
		`(?:[12]hy|[12]h|h[12]|hy)(?:\s?|\s*-\s*)'?\d{2}|\d{1,2}(?:st|nd|rd|th)\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2})`)
	paidForRE = regexp.MustCompile(`\b(?:paid|payable|payment)\s+(?:for|in\s+respect\s+of)\b`)
	// classOfSecurityRE is the class an amount is per ("per fully paid
	// ordinary share", "per partly-paid unit", "per ordinary fully paid CDI");
	// ownPeriodEndAfterRE is what may follow it when it is skipped: the first
	// month name or four-digit year within 40 characters is the period's end
	// in a period phrase ("for the year ended 30 June 2026", "to 30 June
	// 2026"), submatches day and month.
	classOfSecurityRE = regexp.MustCompile(`\bper\s+(?:(?:ordinary|stapled|preference)\s+)?(?:fully|partly|partially)(?:\s*-\s*|\s+)paid` +
		`(?:\s*-\s*up|\s+(?:up|ordinary|stapled|preference))*\s+(?:shares?|securit(?:y|ies)|units?|cdis?)\b`)
	windowDateRE        = regexp.MustCompile(`^.{0,40}?\b(?:(?:` + monthNamesRE + `)\b|(?:19|20)\d{2}\b)`)
	ownPeriodEndAfterRE = regexp.MustCompile(`^.{0,40}?\b(?:ended|ending|end|to)\s+(\d{1,2})\s+(` + monthNamesRE + `)\b`)
	yearRE              = regexp.MustCompile(`\b(?:19|20)\d{2}\b`)
	// fyRE is a fiscal year, alone or after a half ("FY26", "FY-25", "1H
	// FY27", "H1FY26"); halfLabelRE a half label with its fiscal year's
	// digits and no "FY" ("1H25", "H1 25", "2H-25", "HY2026", "1HY26");
	// shortFYRE Woolworths' and TWE's spelling ("F25", "H1 F26"). Their
	// digits are submatch 1.
	fyRE        = regexp.MustCompile(`(?:\b|[12]h|h[12])fy\s*(?:-\s*)?'?(\d{4}|\d{2})\b`)
	halfLabelRE = regexp.MustCompile(`\b(?:[12]hy|[12]h|h[12]|hy)(?:\s?|\s*-\s*)'?(\d{4}|\d{2})\b`)
	shortFYRE   = regexp.MustCompile(`\bf(\d{2})\b`)
	// monthYearRE is a month with a two-digit year ("Jun-25", "June 25",
	// "30-Jun-25", "Dec '25"), the year submatch 1; dayYearRE is what makes
	// the two digits a day instead ("June 30, 2026").
	monthYearRE = regexp.MustCompile(`\b(?:` + monthNamesRE + `)(?:\s*[-/']\s*|\s+)'?(\d{2})\b`)
	dayYearRE   = regexp.MustCompile(`^,?\s*(?:19|20)\d{2}\b`)
	finalRE     = regexp.MustCompile(`\bfinal\b`)
	interimRE   = regexp.MustCompile(`\binterim\b`)
	specialRE   = regexp.MustCompile(`\bspecial\b`)
	// firstHalfRE names a half-year's distribution, another one in an annual
	// document; secondHalfRE the second half's, another one in a half-year
	// document.
	firstHalfRE  = regexp.MustCompile(`\b(?:interim|half[- ]?years?|half[- ]?yearly|first[- ]half|1h(?:fy)?\d{0,4}|h1(?:fy)?\d{0,4}|hy\d{0,4})\b`)
	secondHalfRE = regexp.MustCompile(`\b(?:second[- ]half|2h(?:fy)?\d{0,4}|h2(?:fy)?\d{0,4})\b`)
	// anotherDistributionRE: a sum of distributions or an earlier period's
	// (GDI's "Combined with the 2.50 cents per security interim distribution,
	// total distributions for FY26 of 5.00 cents"), or one not yet decided
	// (guidance, a forecast, another estimate).
	anotherDistributionRE = regexp.MustCompile(`\b(?:total|combined|full[- ]?year|prior|previous|pcp|comparative|corresponding|last year|forecasts?|guidance|expect(?:ed|s)?|estimated?|estimates|anticipated?|targets?|targeted|projected?|outlook)\b`)
)

// distributionLabel reports whether a dividend entry's quote names the
// notice's own distribution (one of type partType, for the period ending
// periodEnd) and no other; why says what failed. A distribution paid on or
// before the period end is another one: an entry that names such a payment
// date or month, or a payment during the period, names an earlier
// distribution (EZZ's "Final dividend paid on 23 December 2025", TWD's "Final
// Dividend Paid 10 December 2025", the FY25 finals in their FY26 documents;
// MEC's "Quarterly dividend paid in June 2026", its March quarter's). So does
// a payment the rule cannot place (unplacedPaymentRE): spelled "paid June
// 2026", MEC's quote would otherwise read as the June quarter's, and TBR's
// "paid to shareholders on 24 November 2025" moved into the period end's
// month would read as its own. Only payment dates after the period end are
// removed before the label is read (MGR's "Final distribution payable on 31
// August 2026"). The quote must then name the own distribution: "final" in an
// annual document, "interim" in a half-year document, or the period end's
// month. It must name no other: any other month; "interim", "half-year",
// "1H", "H1" or "first half" in an annual document; "final" or the second
// half in a half-year document; either, in a document whose period is not
// stated; "special" for an ordinary part ("special" is required for a
// special part); a total, a combined, full-year, prior, previous, pcp,
// comparative or corresponding figure, or a forecast; a year other than the
// period end's, written in full or as a month's two digits ("Jun-25"); or a
// fiscal year other than the document's (fiscalYear), named with "FY"
// ("FY-25"), in a half label ("1H25", "1HY26") or as "F25".
//
// A model's "agree" does not certify the label: the report extractor's
// consensus treats two figures within 0.5% as the same, and an entry's
// "period" attribute is the document's period, not the distribution's (both
// of GMG's entries, interim and final, say "year ended 30 June 2026").
func distributionLabel(quote string, periodEnd time.Time, kind documentKind, partType string) (bool, string) {
	t, why := paymentsAfter(extractiontrust.Normalise(quote), periodEnd)
	if why != "" {
		return false, why
	}
	// A fiscal year is checked here, and its digits are then blanked so the
	// calendar year check below does not read "FY 2027" as 2027.
	fiscal := fiscalYear(periodEnd, kind)
	blank := []byte(t)
	for _, re := range []*regexp.Regexp{fyRE, halfLabelRE, shortFYRE} {
		for _, m := range re.FindAllStringSubmatchIndex(t, -1) {
			if end := m[3]; re == halfLabelRE && end+1 < len(t) && t[end] == '.' && t[end+1] >= '0' && t[end+1] <= '9' {
				continue // "H1 25.0 cents": an amount, not a year
			}
			if fy := t[m[2]:m[3]]; fy != fiscal && fy != fiscal[2:] {
				return false, "names FY" + fy
			}
			for i := m[2]; i < m[3]; i++ {
				blank[i] = ' '
			}
		}
	}
	t = string(blank)
	// A month's two-digit year is the period end's ("Jun-26") or another's
	// ("Jun-25", the comparative year). Two digits followed by decimals are an
	// amount (DXS 03127378's "31 December 19.3", MOG 03140969's "31 december
	// 10.80"), and followed by a year a day ("June 30, 2026").
	yy := strconv.Itoa(periodEnd.Year())[2:]
	for _, m := range monthYearRE.FindAllStringSubmatchIndex(t, -1) {
		end := m[3]
		if end+1 < len(t) && t[end] == '.' && t[end+1] >= '0' && t[end+1] <= '9' || dayYearRE.MatchString(t[end:]) {
			continue
		}
		if t[m[2]:end] != yy {
			return false, "names " + t[m[0]:end]
		}
	}
	own := false
	for _, m := range monthRE.FindAllString(t, -1) {
		if monthOf(m) != periodEnd.Month() {
			return false, "names " + m
		}
		own = true
	}
	year := strconv.Itoa(periodEnd.Year())
	for _, y := range yearRE.FindAllString(t, -1) {
		if y != year {
			return false, "names " + y
		}
	}
	if m := anotherDistributionRE.FindString(t); m != "" {
		return false, "names a " + m + " figure"
	}
	switch kind {
	case periodAnnual:
		if m := firstHalfRE.FindString(t); m != "" {
			return false, "names " + m + " in an annual document"
		}
		own = own || finalRE.MatchString(t)
	case periodHalf:
		if finalRE.MatchString(t) {
			return false, "names final in a half-year document"
		}
		if m := secondHalfRE.FindString(t); m != "" {
			return false, "names " + m + " in a half-year document"
		}
		own = own || interimRE.MatchString(t)
	default:
		if finalRE.MatchString(t) || firstHalfRE.MatchString(t) || secondHalfRE.MatchString(t) {
			return false, "names an interim or final in a document whose period is not stated"
		}
	}
	if special := specialRE.MatchString(t); special != (partType == "special") {
		if special {
			return false, "names a special dividend"
		}
		return false, "does not name a special dividend"
	}
	if !own {
		return false, "names no distribution of its own period"
	}
	return true, ""
}

// monthOf is the month a monthRE match names.
func monthOf(name string) time.Month {
	for m := time.January; m <= time.December; m++ {
		if strings.HasPrefix(strings.ToLower(m.String()), name[:3]) {
			return m
		}
	}
	return 0
}

// paymentsAfter is t with its payment dates after the period end removed;
// why names the first payment on or before the period end (paidDuringRE,
// paymentMonthRE, paymentDateRE), a payment date that is not a date, or a
// payment this rule cannot place (unplacedPaymentRE), and is "" when there is
// none. A payment month or a date with no year is placed only when it is in
// the period end's month (on or before it). In any other month, or a payment
// month with a later year, it is one this rule cannot place. Neither is ever
// removed.
func paymentsAfter(t string, periodEnd time.Time) (string, string) {
	if m := paidDuringRE.FindString(t); m != "" {
		return t, "names a distribution " + m
	}
	for _, m := range paymentMonthRE.FindAllStringSubmatch(t, -1) {
		month := monthOf(m[1])
		if m[2] == "" {
			if month == periodEnd.Month() {
				return t, "names a distribution paid in " + month.String()
			}
			continue
		}
		year, _ := strconv.Atoi(m[2])
		if year < periodEnd.Year() || year == periodEnd.Year() && month <= periodEnd.Month() {
			return t, fmt.Sprintf("names a distribution paid in %s %d", month, year)
		}
	}
	why := ""
	t = paymentDateRE.ReplaceAllStringFunc(t, func(match string) string {
		paid, dated, ok := paymentDay(paymentDateRE.FindStringSubmatch(match), periodEnd)
		switch {
		case why != "":
		case !ok:
			why = "names a payment date this rule cannot read (" + match + ")"
		case dated && !paid.After(periodEnd):
			why = "names a distribution paid " + paid.Format("2 January 2006")
		case !dated && paid.Month() == periodEnd.Month() && !paid.After(periodEnd):
			why = "names a distribution paid " + paid.Format("2 January")
		case dated:
			return " "
		}
		return match
	})
	if why != "" {
		return t, why
	}
	if m := unplacedPaymentRE.FindString(withoutWhatWasPaid(t, periodEnd)); m != "" {
		return t, "names a payment this rule cannot place (" + m + ")"
	}
	return t, ""
}

// withoutWhatWasPaid is t without paidForRE's phrases and without each class
// of security whose first date after it is the period's own end
// (classOfSecurity), for unplacedPaymentRE.
func withoutWhatWasPaid(t string, periodEnd time.Time) string {
	t = paidForRE.ReplaceAllString(t, " ")
	var b strings.Builder
	last := 0
	for _, class := range classOfSecurityRE.FindAllStringIndex(t, -1) {
		if !classOfSecurity(t[class[1]:], periodEnd) {
			continue // its "paid" stays a payment word
		}
		b.WriteString(t[last:class[0]])
		b.WriteByte(' ')
		last = class[1]
	}
	b.WriteString(t[last:])
	return b.String()
}

// classOfSecurity reports whether a class of security, followed by rest,
// says only what the amount is per: no month name or four-digit year within
// 40 characters, or the first is the period end's own day and month in a
// period phrase ("for the year ended 30 June 2026"). Before any other date
// ("on 24 June 2026", "(24 December 2025)", "for June 2026") it may be a
// payment's, so the class's "paid" is left for the window to read.
func classOfSecurity(rest string, periodEnd time.Time) bool {
	date := windowDateRE.FindStringIndex(rest)
	if date == nil {
		return true
	}
	own := ownPeriodEndAfterRE.FindStringSubmatchIndex(rest)
	if own == nil || own[1] != date[1] {
		return false
	}
	day, _ := strconv.Atoi(rest[own[2]:own[3]])
	return day == periodEnd.Day() && monthOf(rest[own[4]:own[5]]) == periodEnd.Month()
}

// paymentDay is the day a paymentDateRE submatch names: dated is false when
// it states no year (it is then read in the period end's year), ok is false
// when it is not a date.
func paymentDay(m []string, periodEnd time.Time) (day time.Time, dated, ok bool) {
	if m == nil {
		return time.Time{}, false, false
	}
	var d, month, year int
	if m[2] != "" {
		d, _ = strconv.Atoi(m[1])
		month, year = int(monthOf(m[2])), periodEnd.Year()
		if m[3] != "" {
			year, _ = strconv.Atoi(m[3])
			dated = true
		}
	} else {
		d, _ = strconv.Atoi(m[4])
		month, _ = strconv.Atoi(m[5])
		year, _ = strconv.Atoi(m[6])
		dated = true
	}
	day = time.Date(year, time.Month(month), d, 0, 0, 0, 0, time.UTC)
	return day, dated, month >= 1 && month <= 12 && day.Day() == d
}

// fiscalYear is the fiscal year a document's own distribution may be
// labelled with. A fiscal year is named by the year it ends in, so whatever
// the year-end, a half that ends July to December belongs to the fiscal year
// named by the next calendar year: a June-year issuer's half to 31 December
// 2026 is "1H FY27", a March-year issuer's half to 30 September 2026 too, and
// "FY26" or "1H26" there names the comparative half. Any other document's is
// its period end's year.
func fiscalYear(periodEnd time.Time, kind documentKind) string {
	if kind == periodHalf && periodEnd.Month() >= time.July {
		return strconv.Itoa(periodEnd.Year() + 1)
	}
	return strconv.Itoa(periodEnd.Year())
}

// Franking an entry states, in its franking attribute or its quote.
var (
	// frankingPlaceholders state nothing: the extractor writes "null" for
	// none (110 prod entries), and models write "N/A" or "not specified".
	frankingPlaceholders = map[string]bool{
		"": true, "null": true, "none stated": true, "n/a": true, "na": true, "not specified": true,
		"not applicable": true, "not stated": true, "not disclosed": true, "unknown": true, "-": true,
	}
	frankingWords = map[string]float64{
		"fully franked": 100, "fully-franked": 100, "100": 100,
		"unfranked": 0, "un-franked": 0, "not franked": 0, "nil": 0, "nil franked": 0, "0": 0, "zero": 0,
	}
	frankingPercentRE = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*%`)
	// In a quote, only words that say how the distribution is franked count.
	quoteFullyFrankedRE = regexp.MustCompile(`\bfully[- ]franked\b`)
	quoteUnfrankedRE    = regexp.MustCompile(`\b(?:unfranked|un-franked|not franked|nil franked)\b`)
	quotePercentRE      = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*%\s*franked\b`)
	quotePartlyRE       = regexp.MustCompile(`\b(?:partially|partly)[- ]franked\b`)
	// quoteFrankedAtRE: "Interim dividend payable – franked at 20% 3.0 cents
	// per share" (AMP's 4D). "Fully franked at 30%" (submatch 1) is fully
	// franked, its credits at the 30% tax rate; in a quote that mentions tax,
	// "franked at N%" may be that rate too, and is not read.
	quoteFrankedAtRE = regexp.MustCompile(`\b(fully[- ])?franked\s+at\s+(\d+(?:\.\d+)?)\s*%`)
)

// attributeFranking reads a dividend entry's franking attribute: stated is
// false when there is none or it says nothing; ok is false when it states
// something this rule cannot read ("partially franked", "4.50 cents
// franked").
func attributeFranking(entry map[string]any) (pct float64, stated, ok bool) {
	v, present := entry["franking"]
	if !present || v == nil {
		return 0, false, true
	}
	s, isString := v.(string)
	if !isString {
		return 0, true, false
	}
	t := extractiontrust.Normalise(s)
	if frankingPlaceholders[t] {
		return 0, false, true
	}
	if p, known := frankingWords[t]; known {
		return p, true, true
	}
	if m := frankingPercentRE.FindAllStringSubmatch(t, -1); len(m) == 1 && !strings.Contains(t, "tax") {
		if p, err := strconv.ParseFloat(m[0][1], 64); err == nil && p <= 100 {
			return p, true, true
		}
	}
	return 0, true, false
}

// quoteFranking reads what an entry's quote says of its franking ("Final
// dividend - fully franked (cents per share) 270", CBA): stated is false when
// it says nothing; ok is false when it says something this rule cannot read,
// or two things.
func quoteFranking(quote string) (pct float64, stated, ok bool) {
	t := extractiontrust.Normalise(quote)
	var found []float64
	if quoteFullyFrankedRE.MatchString(t) {
		found = append(found, 100)
	}
	if quoteUnfrankedRE.MatchString(t) {
		found = append(found, 0)
	}
	for _, m := range quotePercentRE.FindAllStringSubmatch(t, -1) {
		p, err := strconv.ParseFloat(m[1], 64)
		if err != nil || p > 100 {
			return 0, true, false
		}
		found = append(found, p)
	}
	for _, m := range quoteFrankedAtRE.FindAllStringSubmatch(t, -1) {
		if m[1] != "" {
			continue // fully franked, read above
		}
		p, err := strconv.ParseFloat(m[2], 64)
		if err != nil || p > 100 || strings.Contains(t, "tax") {
			return 0, true, false
		}
		found = append(found, p)
	}
	switch {
	case quotePartlyRE.MatchString(t) && len(found) == 0:
		return 0, true, false
	case len(found) == 0:
		return 0, false, true
	case len(found) > 1:
		return 0, true, false
	}
	return found[0], true, true
}

// frankingContradicts is why an entry's franking contradicts the notice's
// franked percentage, or "" when it does not (or says nothing).
func frankingContradicts(entry map[string]any, quote string, noticePct float64) string {
	for _, read := range []func() (float64, bool, bool){
		func() (float64, bool, bool) { return attributeFranking(entry) },
		func() (float64, bool, bool) { return quoteFranking(quote) },
	} {
		pct, stated, ok := read()
		switch {
		case !stated:
		case !ok:
			return "states franking this rule cannot read"
		case math.Abs(pct-noticePct) > 1e-6:
			return fmt.Sprintf("states %s%% franked, the notice %s%%", formatPct(pct), formatPct(noticePct))
		}
	}
	return ""
}

func formatPct(p float64) string { return strconv.FormatFloat(p, 'f', -1, 64) }

// documentRef is how a reason names a document: its ASX idsId when the URL
// has one.
func documentRef(url string) string {
	if i := strings.LastIndex(url, "idsId="); i >= 0 {
		return url[i+len("idsId="):]
	}
	return url
}

// noticeAmount is a part's amount as an exact decimal: its shortest spelling
// is the decimal the notice states (at most 8 decimal places).
func noticeAmount(amount float64) (*big.Rat, bool) {
	return extractiontrust.ParseAmount(strconv.FormatFloat(amount, 'f', -1, 64))
}

// ConfirmEstimate decides whether results documents confirm every estimated
// part of a notice (the gates above this file's types). docs are the
// extractions of the notice's security code that carry a dividend class; any
// other code's are ignored. The data review calls it again for every stored
// estimate, to flag one whose documents no longer confirm it.
func ConfirmEstimate(n DividendNotice, docs []ResultsDocument) EstimateConfirmation {
	if why := estimateConfirmable(n); why != "" {
		return EstimateConfirmation{Reason: why}
	}
	periodEnd, err := time.Parse(time.DateOnly, n.PeriodEnd)
	if err != nil {
		return EstimateConfirmation{Reason: "period end " + n.PeriodEnd + " is not a date"}
	}
	latest := periodEnd.AddDate(0, 0, maxFilingLagDays).Format(time.DateOnly)

	// candidate is an agreed entry whose label names one part's distribution.
	type candidate struct {
		doc     ResultsDocument
		index   int // the entry's place in its document, for a stable order
		quote   string
		entry   map[string]any
		results bool // its document is a results document
	}
	labelled := make([][]candidate, len(n.Parts))
	qualifying := 0
	for _, d := range docs {
		if d.StockCode != n.SecurityCode {
			continue
		}
		meta, err := extractiontrust.ParseDocumentMeta(d.DocumentMeta)
		if err != nil || meta.PeriodEnd != n.PeriodEnd || d.ReportDate == "" || d.ReportDate < n.ActualDue || d.ReportDate > latest ||
			meta.Entity != "" && !extractiontrust.EntityMatches(meta.Entity, d.CompanyName) ||
			meta.Currency != "" && meta.Currency != "AUD" {
			continue
		}
		qualifying++
		if len(d.Dividend) == 0 {
			continue
		}
		results := extractiontrust.IsResultsDocument(d.Title, meta.ReportKind)
		kind := documentKindOf(meta)
		entries, _ := extractiontrust.TrustedEntries(d.Dividend)
		for i, e := range entries {
			if consensus, _ := e["consensus"].(string); strings.TrimSpace(consensus) != "agree" {
				continue
			}
			quote, _ := e[extractiontrust.KeySourceText].(string)
			for p, part := range n.Parts {
				if ok, _ := distributionLabel(quote, periodEnd, kind, part.Type); ok {
					labelled[p] = append(labelled[p], candidate{doc: d, index: i, quote: quote, entry: e, results: results})
				}
			}
		}
	}
	if qualifying == 0 {
		return EstimateConfirmation{Reason: fmt.Sprintf("no document of %s states period end %s and was filed from %s to %s",
			n.SecurityCode, n.PeriodEnd, n.ActualDue, latest)}
	}

	used := map[string]bool{}
	var matches []EstimateMatch
	for p, part := range n.Parts {
		want, ok := noticeAmount(part.Amount)
		if !ok {
			return EstimateConfirmation{Reason: fmt.Sprintf("cannot read the %s amount %v", part.Type, part.Amount)}
		}
		var confirming []candidate
		for _, c := range labelled[p] {
			ref := fmt.Sprintf("%s states %q", documentRef(c.doc.URL), truncate(c.quote, 80))
			amount, ok := extractiontrust.PerSecurityAmount(c.entry)
			if !ok {
				return EstimateConfirmation{Reason: ref + " with no amount per security"}
			}
			if amount.Cmp(want) != 0 {
				return EstimateConfirmation{Reason: fmt.Sprintf("%s: %s a security, not the estimate's %s",
					ref, amount.FloatString(8), want.FloatString(8))}
			}
			if why := frankingContradicts(c.entry, c.quote, *part.FrankedPct); why != "" {
				return EstimateConfirmation{Reason: ref + ", which " + why}
			}
			if c.results {
				confirming = append(confirming, c)
			}
		}
		// The first filed confirms, each entry for one part only.
		slices.SortStableFunc(confirming, func(a, b candidate) int {
			if c := strings.Compare(a.doc.ReportDate, b.doc.ReportDate); c != 0 {
				return c
			}
			if c := strings.Compare(a.doc.URL, b.doc.URL); c != 0 {
				return c
			}
			return a.index - b.index
		})
		matched := false
		for _, c := range confirming {
			key := c.doc.URL + "#" + strconv.Itoa(c.index)
			if used[key] {
				continue
			}
			used[key] = true
			matches = append(matches, EstimateMatch{Type: part.Type, Document: c.doc.URL, Quote: c.quote})
			matched = true
			break
		}
		if !matched {
			return EstimateConfirmation{Reason: fmt.Sprintf("no agreed entry in a results document names the %s distribution for the period ending %s",
				part.Type, n.PeriodEnd)}
		}
	}
	return EstimateConfirmation{Matches: matches}
}

// truncate cuts s to n runes, on one line.
func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// estimateEvidence is what the store knows about an estimated notice's
// dividend beyond the notice.
type estimateEvidence struct {
	// Documents: the extractions of the notice's security code with a
	// dividend class.
	Documents []ResultsDocument
	// Stored: dividend_history's rows for the security code with the
	// notice's ex-date or its 2A.3 period end.
	Stored []storedDividend
	// Later: every other dividend notice listed under a code that shares the
	// security code's first three characters, announced on or after the
	// estimate's day (lodgedAfter decides which of a day's came later).
	Later []laterNotice
}

// storedDividend is a dividend_history row for the notice's code, with its
// ex-date or for its period (estimateStoredSql says what the period also
// withholds: an issuer that states one period end for two distributions).
type storedDividend struct {
	Type, ExDate, AnnouncementURL, AnnouncedOn string
	// ConfirmedEstimate: the notice it was stored from is itself an estimate a
	// results document confirmed.
	ConfirmedEstimate bool
}

// laterNotice is another notice of the same issuer, announced on or after the
// estimate's day.
type laterNotice struct {
	URL         string
	AnnouncedOn string // its ASX announcement date, YYYY-MM-DD
	Outcome     string // its attempt's; "" when it has not been read
	Detail      string
	// StoredDividend: it stored a row for the estimate's code with the same
	// ex-date, or with the same period end and type (a re-lodged notice that
	// moved the ex-date: KME's 2026-09-30 to 10-01, N1H's 11-02 to 10-22).
	StoredDividend bool
}

// lodgedAfter reports whether a notice the store found was lodged after the
// estimate: announced on a later day, or on the same day with a larger ASX
// idsId. PCI lodged 03143304 and its update 03143500 on 2026-09-24; without
// the idsId each counted as later than the other, and neither could ever be
// stored. One whose day or idsId cannot be read counts as later: it withholds.
func lodgedAfter(l laterNotice, p pendingNotice) bool {
	switch {
	case l.AnnouncedOn == "" || l.AnnouncedOn > p.AnnouncementDate:
		return true
	case l.AnnouncedOn < p.AnnouncementDate:
		return false
	}
	later, errL := strconv.ParseInt(documentRef(l.URL), 10, 64)
	own, errP := strconv.ParseInt(documentRef(p.URL), 10, 64)
	return errL != nil || errP != nil || later > own
}

// waitingExRE is the ex-date a waiting notice's detail starts with
// (waitingDetail).
var waitingExRE = regexp.MustCompile(`^ex (\d{4}-\d{2}-\d{2})\b`)

// sameDividend is why a later notice may be about the estimate's dividend, or
// "" when it is known to be about another. Only the issuer's latest word is
// stored: a later notice that stored the dividend already wins, and one that
// failed means the issuer spoke again and that failure needs a look. A notice
// whose ex-date is not known (one not read yet, a cancellation, one the parser
// could not read) counts as the same dividend.
//
// A later notice that still waits (estimated_only, awaiting_aud_equivalent) is
// matched by its ex-date alone: its detail records no period end
// (waitingDetail). Accepted: if an issuer that never sends an actual
// re-lodged an estimate under a moved ex-date, the earlier one could be
// stored under the superseded ex-date (its due date passed first), and the
// re-lodged one then withheld by that row. No prod estimate has moved its
// ex-date (LRT's four notices; the MOT, MXT, PCI, KKC, QRI, TOT and BWP
// pairs).
func sameDividend(l laterNotice, exDate string) string {
	switch l.Outcome {
	case "":
		return "has not been read"
	case "parsed":
		if l.StoredDividend {
			return "stored the same dividend"
		}
		return ""
	case "code_mismatch":
		return "" // another security's
	case "estimated_only", "awaiting_aud_equivalent":
		m := waitingExRE.FindStringSubmatch(l.Detail)
		switch {
		case m == nil:
			return "is " + l.Outcome + " with no ex-date recorded"
		case m[1] == exDate:
			return "is " + l.Outcome + " for the same ex-date"
		}
		return ""
	}
	return "is " + l.Outcome + ", for an ex-date not recorded"
}

// confirmEstimatedNotice decides whether an estimated_only notice is stored
// from its results document: its rows and attempt detail, or why not. It adds
// to ConfirmEstimate what only the store knows: the notice is the latest for
// its dividend (lodgedAfter, sameDividend), and no row of its dividend was
// stored from a declared amount, under its ex-date or, with the same type,
// for its period under another. A row it may replace is its own, or a
// confirmed estimate from a notice announced on an earlier day under the same
// ex-date (upsertConfirmedEstimateSql replaces it in place); a confirmed
// estimate under another ex-date withholds it, since writing would store the
// dividend twice.
func confirmEstimatedNotice(n DividendNotice, p pendingNotice, ev estimateEvidence) (rows []dividendRow, detail, reason string) {
	if why := estimateConfirmable(n); why != "" {
		return nil, "", why
	}
	for _, l := range ev.Later {
		if !lodgedAfter(l, p) {
			continue
		}
		if why := sameDividend(l, n.ExDate); why != "" {
			return nil, "", "later notice " + documentRef(l.URL) + " " + why
		}
	}
	announcedOn := n.AnnouncedOn
	if announcedOn == "" {
		announcedOn = p.AnnouncementDate
	}
	for _, part := range n.Parts {
		for _, s := range ev.Stored {
			switch {
			case s.Type != part.Type || s.AnnouncementURL == p.URL:
				continue
			case s.ExDate != n.ExDate:
				return nil, "", fmt.Sprintf("the %s dividend for the period ending %s is stored from %s (ex %s)",
					part.Type, n.PeriodEnd, documentRef(s.AnnouncementURL), s.ExDate)
			case s.ConfirmedEstimate && s.AnnouncedOn != "" && s.AnnouncedOn < announcedOn:
				continue
			}
			return nil, "", fmt.Sprintf("the %s dividend is stored from %s", part.Type, documentRef(s.AnnouncementURL))
		}
	}
	c := ConfirmEstimate(n, ev.Documents)
	if !c.Confirmed() {
		return nil, "", c.Reason
	}
	for _, part := range n.Parts {
		rows = append(rows, noticeRow(n, p, part, part.Amount, announcedOn))
	}
	return rows, confirmedEstimateDetail(len(rows), c, n.ActualDue), ""
}

// confirmedEstimateDetail is the attempt detail of a stored estimate:
// "1 rows; estimate confirmed by <document URL>; actual amount due
// 2026-08-20". ConfirmedEstimateDetail reads it back.
func confirmedEstimateDetail(rows int, c EstimateConfirmation, due string) string {
	return fmt.Sprintf("%d rows; %s %s; actual amount due %s", rows, confirmedEstimateMarker, strings.Join(c.Documents(), " "), due)
}

var confirmedEstimateDetailRE = regexp.MustCompile(`\b` + confirmedEstimateMarker + ` (.+); actual amount due (\d{4}-\d{2}-\d{2})$`)

// ConfirmedEstimateDetail reads a stored estimate's attempt detail: the
// documents that confirmed it and the date its actual amount was due. ok is
// false for any other detail.
func ConfirmedEstimateDetail(detail string) (documents []string, due string, ok bool) {
	m := confirmedEstimateDetailRE.FindStringSubmatch(detail)
	if m == nil {
		return nil, "", false
	}
	return strings.Fields(m[1]), m[2], true
}
