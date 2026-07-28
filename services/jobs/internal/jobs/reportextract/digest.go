package reportextract

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// digestModel is the model NAME RECORDED in financial_report_extractions.digest_model.
//
// LATENT PYTHON BUG, CARRIED OVER DELIBERATELY: extract.py passes `--model` to
// summarize_report but persists the CONSTANT `DIGEST_MODEL` in the digest_model
// column. Running with `--model something-else` therefore mislabels the stored
// rows. Reproduced rather than fixed, because digest_model is stored data and
// "fixing" it here would make Go-written rows disagree with every Python-written
// row for the same invocation. Flagged in the README.
const digestModel = "gemini-2.5-flash"

// §6.3(b) The digest is generated from raw report text even when langextract
// finds no structured metric table (most "results presentations" lack a clean
// table but still state the headline numbers in prose). The model gets a wider
// text window so it can find figures on its own.
const (
	digestTextChars = 16000
	// minDigestChars: below this the PDF text is too thin to summarise meaningfully.
	minDigestChars = 400
)

// digestTemperature is extract.py's GenerateContentConfig(temperature=0.2).
const digestTemperature = 0.2

// digestPrompt is extract.py's DIGEST_PROMPT, byte-for-byte. It is passed as the
// system instruction, not as user content.
const digestPrompt = `You are summarising an ASX-listed company's financial report or results document for a retail investor.
In 2-3 plain-English sentences, lead with the headline result (revenue and net profit direction with % change),
then the dividend, then any guidance. Be concrete with the numbers.
Prefer the figures in the extracted metrics JSON when present. If the metrics JSON is empty, read the figures
directly from the report text excerpt. If the document states no financial results at all (e.g. it is a cover
note or administrative document), set confidence below 0.3 and concisely summarise what the document covers.
Output STRICT JSON: {"digest": "...", "confidence": 0.0-1.0, "key_takeaways": ["...", "..."]}`

// Markdown fence strippers — extract.py's two re.sub calls, in the same order.
var (
	leadingFenceRE  = regexp.MustCompile("^```(?:json)?\\s*")
	trailingFenceRE = regexp.MustCompile("\\s*```$")
)

// digestResult is the parsed digest response. The zero value is exactly what
// Python returned on every failure path: {"digest": "", "confidence": 0.0,
// "key_takeaways": []}.
type digestResult struct {
	Digest        string          `json:"digest"`
	RawConfidence json.RawMessage `json:"confidence"`
	KeyTakeaways  []string        `json:"key_takeaways"`
	// Confidence is populated by parseDigestJSON with Python float() coercion
	// semantics — see coerceConfidence.
	Confidence float64 `json:"-"`
}

// coerceConfidence reproduces Python's `float(parsed.get("confidence"))`
// inside its blanket except: a JSON number OR a numeric string succeeds;
// null/missing/non-numeric raises in Python, dropping the WHOLE digest —
// so those return an error here rather than defaulting to 0.0 (a value the
// NULL rule was designed to keep out of digest_confidence).
func coerceConfidence(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, fmt.Errorf("confidence missing or null")
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return f, nil
		}
	}
	return 0, fmt.Errorf("confidence %s is not numeric", string(raw))
}

// digestAPIKey mirrors summarize_report's lookup order (GEMINI_API_KEY first,
// then LANGEXTRACT_API_KEY) — the reverse of langextract's own order. Both are
// set to the same secret by the deployed job; the orders are kept distinct
// because each is a separate call site's contract.
func digestAPIKey() string {
	if k := os.Getenv("GEMINI_API_KEY"); k != "" {
		return k
	}
	return os.Getenv("LANGEXTRACT_API_KEY")
}

// summarizer produces a plain-English digest of a report. It is an interface so
// the pipeline is testable without calling Gemini.
type summarizer interface {
	Summarize(ctx context.Context, metrics map[string]any, pageText, modelID string) digestResult
}

// geminiSummarizer is the live implementation.
type geminiSummarizer struct{}

// Summarize generates the digest with a single Gemini call (extract.py's
// summarize_report). Every failure — missing key, API error, unparseable JSON —
// returns the zero digestResult and logs, exactly as Python did; a report is
// still stored, just without a digest.
func (geminiSummarizer) Summarize(ctx context.Context, metrics map[string]any, pageText, modelID string) digestResult {
	apiKey := digestAPIKey()
	if apiKey == "" {
		log.Printf("  No GEMINI_API_KEY / LANGEXTRACT_API_KEY set; skipping digest")
		return digestResult{}
	}

	raw, err := generateDigest(ctx, apiKey, modelID, buildDigestContent(metrics, pageText))
	if err != nil {
		log.Printf("  Digest generation failed: %v", err)
		return digestResult{}
	}

	result, err := parseDigestJSON(raw)
	if err != nil {
		log.Printf("  Digest JSON parse failed: %v — raw: %.200s", err, raw)
		return digestResult{}
	}
	return result
}

// buildDigestContent assembles the user content: the structured metrics JSON
// followed by a truncated raw-text excerpt.
//
// `json.dumps(metrics, indent=2)` → MarshalIndent with two spaces. Go sorts map
// keys where Python preserved insertion order; the model is not order-sensitive
// and the value is not stored, so this is presentation-only.
func buildDigestContent(metrics map[string]any, pageText string) string {
	if metrics == nil {
		metrics = map[string]any{}
	}
	metricsJSON, err := json.MarshalIndent(metrics, "", "  ")
	if err != nil {
		metricsJSON = []byte("{}")
	}
	return fmt.Sprintf("## Extracted metrics (JSON)\n%s\n\n## Report text excerpt\n%s",
		metricsJSON, truncateRunes(pageText, digestTextChars))
}

// generateDigest performs the Gemini call and returns the concatenated text.
func generateDigest(ctx context.Context, apiKey, modelID, userContent string) (string, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return "", fmt.Errorf("create gemini client: %w", err)
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel(modelID)
	model.SetTemperature(digestTemperature)
	model.SystemInstruction = &genai.Content{Parts: []genai.Part{genai.Text(digestPrompt)}}

	resp, err := model.GenerateContent(ctx, genai.Text(userContent))
	if err != nil {
		return "", err
	}
	return geminiText(resp), nil
}

// parseDigestJSON strips markdown fences and decodes the strict-JSON payload.
//
// Field coercion mirrors Python's `str(...)`, `float(...)`, `list(...)`: a
// missing key yields the zero value rather than an error.
func parseDigestJSON(raw string) (digestResult, error) {
	raw = strings.TrimSpace(raw)
	raw = leadingFenceRE.ReplaceAllString(raw, "")
	raw = trailingFenceRE.ReplaceAllString(raw, "")
	raw = strings.TrimSpace(raw)

	var result digestResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return digestResult{}, err
	}
	// Python's float() coercion: null/non-numeric confidence raised inside
	// the blanket except and dropped the whole digest; numeric strings passed.
	conf, err := coerceConfidence(result.RawConfidence)
	if err != nil {
		return digestResult{}, fmt.Errorf("coerce confidence: %w", err)
	}
	result.Confidence = conf
	return result, nil
}

// geminiText concatenates every text part of the first candidate — the Go
// equivalent of the Python SDK's `response.text`.
func geminiText(resp *genai.GenerateContentResponse) string {
	if resp == nil || len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
		return ""
	}
	var b strings.Builder
	for _, part := range resp.Candidates[0].Content.Parts {
		if text, ok := part.(genai.Text); ok {
			b.WriteString(string(text))
		}
	}
	return b.String()
}
