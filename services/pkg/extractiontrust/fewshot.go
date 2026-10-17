package extractiontrust

import (
	"regexp"
	"strings"
)

// Example is one few-shot document for the langextract prompt: the document
// text and its ordered extractions. JSON tags follow langextract's own field
// names so the Python extractor can build lx.data.Extraction(**e) directly from
// testdata/fewshot_example.json.
type Example struct {
	// Entity, ASXCode and Period describe the (fictional) document. They are
	// metadata for humans and tests; the prompt only sees Text and Extractions.
	Entity  string `json:"entity"`
	ASXCode string `json:"asx_code"`
	Period  string `json:"period"`

	Text        string       `json:"text"`
	Extractions []Extraction `json:"extractions"`
}

// Extraction is one few-shot extraction. Class names become the metric keys
// stored in financial_report_extractions.metrics, and attribute keys become the
// keys of each stored entry, so both are a stored-data contract.
type Extraction struct {
	Class      string            `json:"extraction_class"`
	Text       string            `json:"extraction_text"`
	Attributes map[string]string `json:"attributes"`
}

// fewShotPeriod is the period of the synthetic example. A June-year-end
// company's H1 FY2031 is the half year ended 31 December 2030, which no filing
// can yet be the OWN period of; and every flow sentence below also names the
// fictional entity or this period, so no real filing's quote can equal one.
const fewShotPeriod = "H1 FY2031"

// newFewShotExample is the NEW synthetic few-shot example (contract 6.1),
// defined once here. It keeps the exact extraction classes, their order and each
// class's attribute keys from the example it replaces (oldFewShotExample), so
// the stored metric vocabulary does not change; only the document and its
// figures do. Every extraction_text appears verbatim in Text (on one line), so
// langextract aligns the example exactly.
//
// Figures are internally consistent (EBITDA margin 1,529 / 3,847 = 39.7%) and
// share no figure with the old example.
var newFewShotExample = Example{
	Entity:  "Quokka Minerals Limited",
	ASXCode: "QKA",
	Period:  fewShotPeriod,
	Text: `Quokka Minerals Limited (ASX: QKA) Appendix 4D and half year report for H1 FY2031.
Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million, an increase of 7% on the prior corresponding period.
Statutory net profit after tax (NPAT) attributable to Quokka shareholders was $612 million, up 15% on pcp.
Basic earnings per share was 48.3 cents for H1 FY2031.
The Quokka Board declared an interim dividend of 21 cents per share, fully franked.
Operating cash flow for H1 FY2031 was $1,094 million.
H1 FY2031 EBITDA was $1,529 million, representing a margin of 39.7%.
FY2031 guidance: Quokka expects revenue growth of 4-6%.`,
	Extractions: []Extraction{
		{
			Class: "revenue",
			Text:  "Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million",
			Attributes: map[string]string{
				"value_millions": "3847",
				"period":         fewShotPeriod,
				"change_pct":     "+7",
			},
		},
		{
			Class: "net_profit",
			Text:  "Statutory net profit after tax (NPAT) attributable to Quokka shareholders was $612 million, up 15% on pcp",
			Attributes: map[string]string{
				"value_millions": "612",
				"period":         fewShotPeriod,
				"change_pct":     "+15",
			},
		},
		{
			Class: "eps",
			Text:  "Basic earnings per share was 48.3 cents for H1 FY2031",
			Attributes: map[string]string{
				"value_cents": "48.3",
				"period":      fewShotPeriod,
			},
		},
		{
			Class: "dividend",
			Text:  "The Quokka Board declared an interim dividend of 21 cents per share, fully franked",
			Attributes: map[string]string{
				"value_cents": "21",
				"franking":    "fully franked",
				"period":      fewShotPeriod,
			},
		},
		{
			Class: "cash_flow",
			Text:  "Operating cash flow for H1 FY2031 was $1,094 million",
			Attributes: map[string]string{
				"value_millions": "1094",
				"period":         fewShotPeriod,
			},
		},
		{
			Class: "ebitda",
			Text:  "H1 FY2031 EBITDA was $1,529 million, representing a margin of 39.7%",
			Attributes: map[string]string{
				"value_millions": "1529",
				"margin_pct":     "39.7",
				"period":         fewShotPeriod,
			},
		},
		{
			Class: "guidance",
			Text:  "FY2031 guidance: Quokka expects revenue growth of 4-6%",
			Attributes: map[string]string{
				"metric": "revenue_growth",
				"range":  "4-6%",
				"period": "FY2031",
			},
		},
	},
}

// oldFewShotExample is the example extract.py's EXTRACTION_EXAMPLES and
// reportextract's extractionExamples carried until contract 6.1, VERBATIM
// (including the line break inside the revenue sentence). Measured on prod
// 2026-09-28, the model echoed it back for BHP, CBA, DRO, EDV and MSB (revenue
// $5,142m, NPAT $1,823m, EPS 94.2c, "H1 FY2025"), so its texts stay on the
// denylist permanently: those rows are already stored.
var oldFewShotExample = Example{
	Entity:  "",
	ASXCode: "",
	Period:  "H1 FY2025",
	Text: `Revenue from continuing operations for the half year ended 31 December 2024
was $5,142 million, an increase of 8% on the prior corresponding period.
Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp.
Basic earnings per share was 94.2 cents.
The Board declared an interim dividend of 45 cents per share, fully franked.
Operating cash flow was $2,156 million.
EBITDA was $2,891 million, representing a margin of 56.2%.
FY2025 guidance: Revenue growth of 6-8% expected.`,
	Extractions: []Extraction{
		{Class: "revenue", Text: "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
			Attributes: map[string]string{"value_millions": "5142", "period": "H1 FY2025", "change_pct": "+8"}},
		{Class: "net_profit", Text: "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp",
			Attributes: map[string]string{"value_millions": "1823", "period": "H1 FY2025", "change_pct": "+12"}},
		{Class: "eps", Text: "Basic earnings per share was 94.2 cents",
			Attributes: map[string]string{"value_cents": "94.2", "period": "H1 FY2025"}},
		{Class: "dividend", Text: "interim dividend of 45 cents per share, fully franked",
			Attributes: map[string]string{"value_cents": "45", "franking": "fully franked", "period": "H1 FY2025"}},
		{Class: "cash_flow", Text: "Operating cash flow was $2,156 million",
			Attributes: map[string]string{"value_millions": "2156", "period": "H1 FY2025"}},
		{Class: "ebitda", Text: "EBITDA was $2,891 million, representing a margin of 56.2%",
			Attributes: map[string]string{"value_millions": "2891", "margin_pct": "56.2", "period": "H1 FY2025"}},
		{Class: "guidance", Text: "FY2025 guidance: Revenue growth of 6-8% expected",
			Attributes: map[string]string{"metric": "revenue_growth", "range": "6-8%", "period": "FY2025"}},
	},
}

// FewShotExample returns the synthetic few-shot example every extractor must
// use, as a fresh deep copy (callers may convert or mutate it freely; the
// denylist is built from a private copy).
func FewShotExample() Example { return newFewShotExample.clone() }

// OldFewShotTexts are the texts of the example the extractors used before the
// synthetic one: every extraction_text verbatim, then each sentence of its
// document not already listed (the model echoes either; a sentence that equals
// an extraction_text up to its final period is listed once), then the whole
// document. Informational; IsFewShotText matches against a private copy.
var OldFewShotTexts = fewShotTexts(oldFewShotExample)

// NewFewShotTexts are the same texts for the synthetic example (FewShotExample),
// derived from it. A model that echoes the new example is caught exactly as one
// that echoed the old one.
var NewFewShotTexts = fewShotTexts(newFewShotExample)

// fewShotKeys is the private lookup set IsFewShotText reads, built from the
// unexported examples so a caller mutating the exported slices cannot open a
// hole in the denylist.
var fewShotKeys = func() map[string]struct{} {
	keys := map[string]struct{}{}
	for _, ex := range []Example{oldFewShotExample, newFewShotExample} {
		for _, t := range fewShotTexts(ex) {
			if k := fewShotKey(t); k != "" {
				keys[k] = struct{}{}
			}
		}
	}
	return keys
}()

// IsFewShotText reports whether sourceText is one of the few-shot example texts
// (old or new), compared after Normalise and ignoring trailing sentence
// punctuation ("... 94.2 cents." equals "... 94.2 cents").
//
// Exact after normalisation, NEVER a value match: a real filing that states the
// same figure in its own words ("Statutory NPAT2 $5,142m") is not a few-shot
// echo. The accepted cost: a real quote identical to an OLD example sentence
// (for instance "interim dividend of 45 cents per share, fully franked") is also
// withheld, because the stored echoes cannot be told apart from it.
func IsFewShotText(sourceText string) bool {
	k := fewShotKey(sourceText)
	if k == "" {
		return false
	}
	_, ok := fewShotKeys[k]
	return ok
}

// fewShotKey is the comparison form: Normalise, then drop trailing sentence
// punctuation and spaces.
func fewShotKey(s string) string {
	return strings.TrimRight(Normalise(s), " .;:,")
}

// sentenceEnd splits a whitespace-collapsed document into sentences: a period
// followed by a space. Decimal points ("94.2", "56.2%") are never followed by a
// space, so they do not split.
var sentenceEnd = regexp.MustCompile(`\.\s+`)

// fewShotTexts lists an example's echo-able texts in a stable order:
// extraction texts, document sentences, the whole document. Duplicates (after
// fewShotKey) are dropped, first occurrence kept.
func fewShotTexts(ex Example) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		k := fewShotKey(s)
		if k == "" || seen[k] {
			return
		}
		seen[k] = true
		out = append(out, s)
	}
	for _, e := range ex.Extractions {
		add(e.Text)
	}
	collapsed := strings.Join(strings.Fields(ex.Text), " ")
	for _, s := range sentenceEnd.Split(collapsed, -1) {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !strings.HasSuffix(s, ".") {
			s += "."
		}
		add(s)
	}
	add(collapsed)
	return out
}

func (ex Example) clone() Example {
	out := ex
	out.Extractions = make([]Extraction, len(ex.Extractions))
	for i, e := range ex.Extractions {
		attrs := make(map[string]string, len(e.Attributes))
		for k, v := range e.Attributes {
			attrs[k] = v
		}
		e.Attributes = attrs
		out.Extractions[i] = e
	}
	return out
}
