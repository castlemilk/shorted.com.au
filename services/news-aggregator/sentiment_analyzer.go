package main

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// SentimentAnalyzer uses Gemini Flash for fast, cheap sentiment classification.
type SentimentAnalyzer struct {
	client *genai.Client
	model  string
}

// NewSentimentAnalyzer creates a new Gemini Flash-powered sentiment analyzer.
func NewSentimentAnalyzer(ctx context.Context, apiKey string) (*SentimentAnalyzer, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}
	return &SentimentAnalyzer{
		client: client,
		model:  "gemini-2.0-flash",
	}, nil
}

// AnalyzeBatch classifies a batch of headlines as positive/negative/neutral.
// Returns a slice of sentiment strings in the same order as input headlines.
func (sa *SentimentAnalyzer) AnalyzeBatch(ctx context.Context, headlines []string) ([]string, error) {
	if len(headlines) == 0 {
		return nil, nil
	}

	// Build numbered headline list
	var sb strings.Builder
	for i, h := range headlines {
		fmt.Fprintf(&sb, "%d. %s\n", i+1, h)
	}

	prompt := fmt.Sprintf(`Classify each headline's financial sentiment as exactly one of: positive, negative, neutral.

Reply with ONLY the sentiment for each headline, one per line, in the same order. No numbering, no explanation.

Headlines:
%s`, sb.String())

	model := sa.client.GenerativeModel(sa.model)
	model.SetTemperature(0)

	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		recordNewsGeminiGeneration(ctx, "news_sentiment", sa.model, "batch", "error", nil)
		return nil, fmt.Errorf("generate content: %w", err)
	}
	recordNewsGeminiGeneration(ctx, "news_sentiment", sa.model, "batch", "success", resp.UsageMetadata)

	// Parse response
	text := extractGeminiText(resp)
	lines := strings.Split(strings.TrimSpace(text), "\n")

	results := make([]string, len(headlines))
	for i := range headlines {
		if i < len(lines) {
			sentiment := strings.TrimSpace(strings.ToLower(lines[i]))
			switch sentiment {
			case "positive", "negative", "neutral":
				results[i] = sentiment
			default:
				// Try to extract sentiment from longer response line
				lower := strings.ToLower(lines[i])
				if strings.Contains(lower, "positive") {
					results[i] = "positive"
				} else if strings.Contains(lower, "negative") {
					results[i] = "negative"
				} else {
					results[i] = "neutral"
				}
			}
		} else {
			results[i] = "neutral"
		}
	}

	return results, nil
}

// Close closes the underlying client.
func (sa *SentimentAnalyzer) Close() {
	if sa.client != nil {
		_ = sa.client.Close()
	}
}

func extractGeminiText(resp *genai.GenerateContentResponse) string {
	for _, cand := range resp.Candidates {
		if cand.Content != nil {
			for _, part := range cand.Content.Parts {
				if text, ok := part.(genai.Text); ok {
					return string(text)
				}
			}
		}
	}
	return ""
}

// AnalyzeBatchWithFallback classifies headlines, falling back to keyword heuristic on error.
func (sa *SentimentAnalyzer) AnalyzeBatchWithFallback(ctx context.Context, headlines []string) []string {
	results, err := sa.AnalyzeBatch(ctx, headlines)
	if err != nil {
		log.Printf("Sentiment analysis failed, using keyword fallback: %v", err)
		results = make([]string, len(headlines))
		for i, h := range headlines {
			results[i] = classifySimpleSentiment(h)
		}
	}
	return results
}
