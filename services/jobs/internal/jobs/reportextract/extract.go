package reportextract

import (
	"context"
	"log"
	"os"
	"strconv"
	"unicode/utf8"

	lx "github.com/skunkworq/stealth/brws/langextract"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
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

// extractionExamples is the extraction prompt's few-shot example: ONE
// ExampleData built from extractiontrust.FewShotExample(), the synthetic
// "Quokka Minerals Limited" H1 FY2031 document (docs/plans/fundamentals-coverage.md
// 6.1, 6.3). It is derived, never retyped, so the text, the class names, the
// extraction texts and the attribute keys/values are byte-identical to the
// package that defines them (and to extract.py, which copies the same example;
// TestExtractPyExampleMatchesTheTrustExample enforces that side).
//
// The example it replaces (revenue $5,142m, NPAT $1,823m, EPS 94.2c, "H1
// FY2025") was echoed back by the model and stored as BHP's, CBA's, DRO's,
// EDV's and MSB's results; its texts stay on extractiontrust's denylist.
func extractionExamples() []lx.ExampleData {
	ex := extractiontrust.FewShotExample()
	out := lx.ExampleData{Text: ex.Text, Extractions: make([]lx.Extraction, 0, len(ex.Extractions))}
	for _, e := range ex.Extractions {
		attrs := make(map[string]any, len(e.Attributes))
		for k, v := range e.Attributes {
			attrs[k] = v
		}
		out.Extractions = append(out.Extractions, lx.Extraction{
			ExtractionClass: e.Class,
			ExtractionText:  e.Text,
			Attributes:      attrs,
		})
	}
	return []lx.ExampleData{out}
}

// extraction is one langextract result, flattened the way extract.py flattened
// it before building the metrics dict.
type extraction struct {
	Class      string
	Text       string
	Attributes map[string]any
	// Alignment is langextract's alignment status (match_exact, match_greater,
	// match_lesser, match_fuzzy) and CharStart/CharEnd the aligned span in the
	// document text. groundedExtractions only keeps aligned results, so a
	// stored entry always carries them; "" / -1 only in hand-built test values.
	Alignment string
	CharStart int
	CharEnd   int
}

// alignedStatuses are the langextract statuses that mean the extraction was
// found in the document (extractiontrust's Grounded accepts exactly these).
var alignedStatuses = map[lx.AlignmentStatus]bool{
	lx.AlignmentExact:   true,
	lx.AlignmentGreater: true,
	lx.AlignmentLesser:  true,
	lx.AlignmentFuzzy:   true,
}

// groundedExtractions keeps only the results langextract aligned to the
// document (contract 6.3, parity with extract.py 6.1): no char interval, or an
// alignment status outside alignedStatuses, means the model produced text that
// is not in the report (the few-shot echo was exactly this), so it is dropped
// before it can be stored. dropped counts them for the log.
func groundedExtractions(raw []lx.Extraction) (out []extraction, dropped int) {
	out = make([]extraction, 0, len(raw))
	for _, e := range raw {
		if e.CharInterval == nil || !alignedStatuses[e.Alignment] {
			dropped++
			continue
		}
		out = append(out, extraction{
			Class:      e.ExtractionClass,
			Text:       e.ExtractionText,
			Attributes: e.Attributes,
			Alignment:  string(e.Alignment),
			CharStart:  e.CharStart(),
			CharEnd:    e.CharEnd(),
		})
	}
	return out, dropped
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

	out, dropped := groundedExtractions(raw.Extractions)
	if dropped > 0 {
		log.Printf("  %s: dropped %d unaligned extraction(s)", stockCode, dropped)
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
		// Provenance as STRING attributes, exactly as extract.py stores them
		// (contract 6.1): the trust funnel reads "alignment", and the three
		// keys are stripped before any prompt or API response.
		if ext.Alignment != "" {
			entry[extractiontrust.KeyAlignment] = ext.Alignment
			entry[extractiontrust.KeyCharStart] = strconv.Itoa(ext.CharStart)
			entry[extractiontrust.KeyCharEnd] = strconv.Itoa(ext.CharEnd)
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
