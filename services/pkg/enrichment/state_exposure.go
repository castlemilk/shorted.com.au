package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"
)

// StateExposure is one operations-weighted geographic exposure entry stored in
// the "company-metadata".state_exposure JSONB column.
type StateExposure struct {
	Region string  `json:"region"`
	Weight float64 `json:"weight"`
	Basis  string  `json:"basis"`
}

// validStateExposureRegions is the closed set of allowed region keys.
var validStateExposureRegions = map[string]bool{
	"nsw":           true,
	"vic":           true,
	"qld":           true,
	"sa":            true,
	"wa":            true,
	"tas":           true,
	"nt":            true,
	"act":           true,
	"international": true,
}

// maxStateExposureEntries caps how many entries a single company may carry.
const maxStateExposureEntries = 6

// ValidateStateExposure sanitizes an LLM-produced exposure list:
//   - errors on empty input or more than maxStateExposureEntries raw entries
//   - drops entries with invalid regions or zero/negative weights
//   - merges duplicate regions (weights summed, first non-empty basis wins) —
//     mv_company_state_exposure has a unique (stock_code, region) index, so a
//     duplicate region must never reach the database
//   - errors if nothing survives filtering
//   - renormalizes surviving weights to sum exactly 1.0 (2dp, residual folded
//     into the largest entry)
func ValidateStateExposure(raw []StateExposure) ([]StateExposure, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("state exposure is empty")
	}
	if len(raw) > maxStateExposureEntries {
		return nil, fmt.Errorf("state exposure has %d entries (max %d)", len(raw), maxStateExposureEntries)
	}

	valid := make([]StateExposure, 0, len(raw))
	indexByRegion := make(map[string]int, len(raw))
	for _, e := range raw {
		region := strings.ToLower(strings.TrimSpace(e.Region))
		if !validStateExposureRegions[region] {
			continue
		}
		if e.Weight <= 0 {
			continue
		}
		basis := strings.TrimSpace(e.Basis)
		if idx, seen := indexByRegion[region]; seen {
			// Merge duplicate regions: sum weights, first non-empty basis wins.
			valid[idx].Weight += e.Weight
			if valid[idx].Basis == "" {
				valid[idx].Basis = basis
			}
			continue
		}
		indexByRegion[region] = len(valid)
		valid = append(valid, StateExposure{
			Region: region,
			Weight: e.Weight,
			Basis:  basis,
		})
	}

	if len(valid) == 0 {
		return nil, fmt.Errorf("state exposure has no valid entries after filtering")
	}

	// Renormalize weights to sum exactly 1.0.
	total := 0.0
	for _, e := range valid {
		total += e.Weight
	}
	largestIdx := 0
	roundedSum := 0.0
	for i := range valid {
		valid[i].Weight = math.Round(valid[i].Weight/total*100) / 100
		roundedSum += valid[i].Weight
		if valid[i].Weight > valid[largestIdx].Weight {
			largestIdx = i
		}
	}
	// Fold any 2dp rounding residual into the largest entry so the sum is exact.
	if residual := 1.0 - roundedSum; residual != 0 {
		valid[largestIdx].Weight = math.Round((valid[largestIdx].Weight+residual)*100) / 100
	}

	return valid, nil
}

// StateExposureCompanyInput carries the company context fed to the LLM when
// generating a state exposure breakdown.
type StateExposureCompanyInput struct {
	StockCode   string
	CompanyName string
	Industry    string
	Sector      string
	Summary     string
	Description string
}

const stateExposureDescriptionLimit = 1500

// GenerateStateExposure asks the LLM for an operations-weighted geographic
// exposure breakdown for a single company. It is deliberately a concrete-type
// method on OpenAIGPTClient (NOT part of the GPTClient interface) — only the
// --backfill-state-exposure mode uses it.
func (c *OpenAIGPTClient) GenerateStateExposure(ctx context.Context, company StateExposureCompanyInput) ([]StateExposure, error) {
	if strings.TrimSpace(company.StockCode) == "" {
		return nil, fmt.Errorf("stock code is required")
	}

	systemPrompt := `You are a financial analyst specializing in Australian Stock Exchange (ASX) companies.

Your task: estimate a company's operations-weighted geographic exposure — the share of its operating assets and revenue-generating activity in each Australian state/territory, or internationally.

Return ONLY valid JSON. No markdown. No commentary.`

	description := strings.TrimSpace(company.Description)
	if len(description) > stateExposureDescriptionLimit {
		description = description[:stateExposureDescriptionLimit]
	}

	userPrompt := fmt.Sprintf(`<company_context>
Company Name: %s
Stock Code: %s
Industry: %s
Sector: %s
Summary: %s
Description: %s
</company_context>

Return a JSON object with this EXACT structure:

{"state_exposure": [{"region": "wa", "weight": 0.85, "basis": "Pilbara iron ore operations"}]}

Rules:
- "region" MUST be one of: nsw, vic, qld, sa, wa, tas, nt, act, international
- weights MUST sum to 1.0
- 1-5 entries
- weight = share of operating assets / revenue-generating activity in that region — NOT the registered office location
- use "international" for all non-Australian operations combined
- "basis" is a short justification, 8 words or fewer

Examples:

BHP Group (BHP) — global miner headquartered in Melbourne, but exposure follows the operating assets:
{"state_exposure": [{"region":"wa","weight":0.55,"basis":"Pilbara iron ore operations"},{"region":"qld","weight":0.2,"basis":"Coking coal mines"},{"region":"sa","weight":0.1,"basis":"Olympic Dam copper"},{"region":"international","weight":0.15,"basis":"Americas potash and copper"}]}

CSL Limited (CSL) — Melbourne-based biotech with mostly offshore operations:
{"state_exposure": [{"region":"vic","weight":0.25,"basis":"Melbourne R&D and manufacturing"},{"region":"international","weight":0.75,"basis":"Global plasma collection and sales"}]}`,
		company.CompanyName, company.StockCode, company.Industry, company.Sector, company.Summary, description)

	req := openai.ChatCompletionRequest{
		Model: c.model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		Temperature: 0.1,
	}

	resp, err := retryableOpenAICall(ctx, defaultRetryConfig, "state exposure generation", func() (openai.ChatCompletionResponse, error) {
		callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		return c.client.CreateChatCompletion(callCtx, req)
	})
	if err != nil {
		return nil, err
	}
	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("state exposure generation returned no choices")
	}

	raw := strings.TrimSpace(resp.Choices[0].Message.Content)
	raw = extractLikelyJSON(raw)

	var parsed struct {
		StateExposure []StateExposure `json:"state_exposure"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse state exposure JSON: %w", err)
	}

	return parsed.StateExposure, nil
}
