package extractiontrust

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
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
	for _, c := range strings.Fields(codes) {
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
//     characters;
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
	m.Entity = freeText(str("entity"))
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
	for i := 0; i < 11; i++ {
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
