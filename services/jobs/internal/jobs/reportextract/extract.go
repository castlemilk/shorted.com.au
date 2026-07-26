package reportextract

import (
	"context"
	"log"
	"os"
	"unicode/utf8"

	lx "github.com/skunkworq/stealth/brws/langextract"
)

// extractionPrompt is extract.py's EXTRACTION_PROMPT, byte-for-byte.
const extractionPrompt = `Extract key financial metrics from this ASX company financial report.
For each metric found, extract the exact text containing the number and classify it.
Focus on the MOST RECENT reporting period (not comparative/prior period).
All monetary values should be in millions AUD unless stated otherwise.
Only extract metrics that are explicitly stated - do not calculate or infer.`

// maxExtractionChars truncates very long report text to stay within token limits
// (extract.py: `if len(text) > 50000: text = text[:50000]`). Python's len() and
// slicing count CODE POINTS, so every char-denominated limit in this package goes
// through truncateRunes / runeLen rather than Go's byte-oriented len().
const maxExtractionChars = 50000

// langextract tuning, matching extract.py's lx.extract(...) call exactly.
const (
	extractionPasses     = 1
	extractMaxWorkers    = 1
	extractMaxCharBuffer = 2000
)

// extractionExamples is extract.py's EXTRACTION_EXAMPLES — one ExampleData with
// seven few-shot extractions. Class names, extraction texts and attribute
// keys/values are the prompt's contract with the model and are reproduced
// verbatim; changing any of them changes what the model emits.
func extractionExamples() []lx.ExampleData {
	return []lx.ExampleData{{
		Text: `Revenue from continuing operations for the half year ended 31 December 2024
was $5,142 million, an increase of 8% on the prior corresponding period.
Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp.
Basic earnings per share was 94.2 cents.
The Board declared an interim dividend of 45 cents per share, fully franked.
Operating cash flow was $2,156 million.
EBITDA was $2,891 million, representing a margin of 56.2%.
FY2025 guidance: Revenue growth of 6-8% expected.`,
		Extractions: []lx.Extraction{
			{
				ExtractionClass: "revenue",
				ExtractionText:  "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million",
				Attributes: map[string]any{
					"value_millions": "5142",
					"period":         "H1 FY2025",
					"change_pct":     "+8",
				},
			},
			{
				ExtractionClass: "net_profit",
				ExtractionText:  "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp",
				Attributes: map[string]any{
					"value_millions": "1823",
					"period":         "H1 FY2025",
					"change_pct":     "+12",
				},
			},
			{
				ExtractionClass: "eps",
				ExtractionText:  "Basic earnings per share was 94.2 cents",
				Attributes: map[string]any{
					"value_cents": "94.2",
					"period":      "H1 FY2025",
				},
			},
			{
				ExtractionClass: "dividend",
				ExtractionText:  "interim dividend of 45 cents per share, fully franked",
				Attributes: map[string]any{
					"value_cents": "45",
					"franking":    "fully franked",
					"period":      "H1 FY2025",
				},
			},
			{
				ExtractionClass: "cash_flow",
				ExtractionText:  "Operating cash flow was $2,156 million",
				Attributes: map[string]any{
					"value_millions": "2156",
					"period":         "H1 FY2025",
				},
			},
			{
				ExtractionClass: "ebitda",
				ExtractionText:  "EBITDA was $2,891 million, representing a margin of 56.2%",
				Attributes: map[string]any{
					"value_millions": "2891",
					"margin_pct":     "56.2",
					"period":         "H1 FY2025",
				},
			},
			{
				ExtractionClass: "guidance",
				ExtractionText:  "FY2025 guidance: Revenue growth of 6-8% expected",
				Attributes: map[string]any{
					"metric": "revenue_growth",
					"range":  "6-8%",
					"period": "FY2025",
				},
			},
		},
	}}
}

// extraction is one langextract result, flattened the way extract.py flattened
// it before building the metrics dict.
type extraction struct {
	Class      string
	Text       string
	Attributes map[string]any
}

// langextractAPIKey resolves the key langextract itself reads from the
// environment in Python (LANGEXTRACT_API_KEY), falling back to GEMINI_API_KEY.
// The deployed job sets BOTH to the same secret.
//
// DIVERGENCE (mechanical): the Python library picks the key up implicitly; the Go
// port takes it through ModelConfig.ProviderKwargs, so it must be read here.
func langextractAPIKey() string {
	if k := os.Getenv("LANGEXTRACT_API_KEY"); k != "" {
		return k
	}
	return os.Getenv("GEMINI_API_KEY")
}

// extractFinancialData runs langextract over report text (extract.py's
// extract_financial_data).
//
// Like Python, EVERY failure is swallowed into "no extractions" plus a warning:
// a model error must not fail the report, because the digest step still runs off
// raw text and is often the only useful output for a results presentation.
func extractFinancialData(ctx context.Context, text, stockCode, modelID string) []extraction {
	text = truncateRunes(text, maxExtractionChars)

	apiKey := langextractAPIKey()
	if apiKey == "" {
		// Python reached lx.extract with no key and got a provider error, which
		// its blanket `except` turned into this same warning + empty result.
		log.Printf("  langextract failed for %s: no LANGEXTRACT_API_KEY / GEMINI_API_KEY set", stockCode)
		return nil
	}

	raw, err := lx.ExtractRaw(ctx, text,
		lx.WithPromptDescription(extractionPrompt),
		lx.WithExamples(extractionExamples()...),
		lx.WithModelConfig(lx.ModelConfig{
			ModelID:  modelID,
			Provider: "gemini",
			ProviderKwargs: map[string]any{
				"api_key": apiKey,
			},
		}),
		lx.WithExtractionPasses(extractionPasses),
		lx.WithMaxWorkers(extractMaxWorkers),
		lx.WithMaxCharBuffer(extractMaxCharBuffer),
	)
	if err != nil {
		log.Printf("  langextract failed for %s: %v", stockCode, err)
		return nil
	}
	if raw == nil {
		return nil
	}

	out := make([]extraction, 0, len(raw.Extractions))
	for _, e := range raw.Extractions {
		out = append(out, extraction{
			Class:      e.ExtractionClass,
			Text:       e.ExtractionText,
			Attributes: e.Attributes,
		})
	}
	return out
}

// extractionsToMetrics converts langextract extractions to the metrics object
// stored in financial_report_extractions.metrics (extract.py's
// extractions_to_metrics).
//
// One entry per class; a REPEATED class collapses into a list, and the list is
// only created on the second occurrence — so `{"revenue": {...}}` and
// `{"revenue": [{...}, {...}]}` are both valid shapes downstream. That
// heterogeneity is a stored-data contract with the weekly-report generator, so
// it is reproduced rather than normalised.
func extractionsToMetrics(extractions []extraction) map[string]any {
	metrics := map[string]any{}
	for _, ext := range extractions {
		entry := map[string]any{"source_text": ext.Text}
		for k, v := range ext.Attributes {
			entry[k] = v
		}
		existing, seen := metrics[ext.Class]
		if !seen {
			metrics[ext.Class] = entry
			continue
		}
		if list, ok := existing.([]any); ok {
			metrics[ext.Class] = append(list, entry)
			continue
		}
		metrics[ext.Class] = []any{existing, entry}
	}
	return metrics
}

// truncateRunes cuts s to at most n CODE POINTS — Python's `s[:n]`, not Go's
// byte slice. ASX filings carry en dashes, curly quotes and ligatures routinely,
// so the two differ in practice.
func truncateRunes(s string, n int) string {
	if len(s) <= n { // bytes <= n implies runes <= n
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// runeLen is Python's len(str): a CODE POINT count. It feeds the stored
// raw_text_length column and the MIN_DIGEST_CHARS / 100-char floors, so byte
// length would be a silent data divergence.
func runeLen(s string) int { return utf8.RuneCountInString(s) }
