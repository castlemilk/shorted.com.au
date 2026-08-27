package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPromptsListMatchesTheRegistry(t *testing.T) {
	ctx := context.Background()
	res, err := connectWithSource(t).ListPrompts(ctx, nil)
	if err != nil {
		t.Fatalf("prompts/list: %v", err)
	}

	registered := Prompts()
	if len(registered) == 0 {
		t.Fatal("no prompts registered")
	}
	if len(res.Prompts) != len(registered) {
		t.Fatalf("prompts/list served %d, Prompts() holds %d", len(res.Prompts), len(registered))
	}

	served := map[string]*sdk.Prompt{}
	for _, p := range res.Prompts {
		served[p.Name] = p
	}
	for _, want := range registered {
		got, ok := served[want.Name]
		if !ok {
			t.Errorf("prompt %q is registered but not served", want.Name)
			continue
		}
		if got.Description != want.Description {
			t.Errorf("prompt %q: served description differs from the registry's", want.Name)
		}
		if len(got.Arguments) != len(want.Arguments) {
			t.Errorf("prompt %q: served %d arguments, registry declares %d",
				want.Name, len(got.Arguments), len(want.Arguments))
		}
	}
}

// A prompt is only worth its listing cost if it renders with the caller's
// arguments actually substituted in. A template that ignores its ticker sends
// the model off to brief the wrong company.
func TestPromptsRenderWithArgumentsSubstituted(t *testing.T) {
	ctx := context.Background()
	session := connectWithSource(t)

	cases := []struct {
		prompt string
		args   map[string]string
		want   []string
	}{
		{
			prompt: "short_interest_briefing",
			args:   map[string]string{"ticker": "lot", "period": "1Y"},
			// Uppercased: the tools take ASX codes uppercase, and a prompt
			// that passes through the user's casing makes the model guess.
			want: []string{"LOT", "1Y", "get_stock", "get_stock_history", "get_director_trades"},
		},
		{
			prompt: "suburb_housing_brief",
			args:   map[string]string{"state": "nsw", "suburb": "Marrickville"},
			want:   []string{"NSW", "Marrickville", "get_suburb_profile", "list_suburb_price_drops"},
		},
		{
			prompt: "market_wrap",
			args:   map[string]string{"period": "3M"},
			want:   []string{"3M", "list_top_shorts", "get_industry_treemap", "list_squeeze_candidates"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.prompt, func(t *testing.T) {
			res, err := session.GetPrompt(ctx, &sdk.GetPromptParams{
				Name:      tc.prompt,
				Arguments: tc.args,
			})
			if err != nil {
				t.Fatalf("prompts/get %s: %v", tc.prompt, err)
			}
			if len(res.Messages) == 0 {
				t.Fatal("prompt rendered no messages")
			}
			var body strings.Builder
			for _, msg := range res.Messages {
				if msg.Role != "user" {
					t.Errorf("message role = %q, want user", msg.Role)
				}
				text, ok := msg.Content.(*sdk.TextContent)
				if !ok {
					t.Fatalf("message content is %T, want *sdk.TextContent", msg.Content)
				}
				body.WriteString(text.Text)
			}
			rendered := body.String()
			for _, want := range tc.want {
				if !strings.Contains(rendered, want) {
					t.Errorf("rendered prompt does not contain %q:\n%s", want, rendered)
				}
			}
		})
	}
}

// Optional arguments must have a stated default in the rendered text, not an
// empty hole — "over the period " is an instruction to guess.
func TestPromptsFillOptionalArgumentDefaults(t *testing.T) {
	res, err := connectWithSource(t).GetPrompt(context.Background(), &sdk.GetPromptParams{
		Name:      "short_interest_briefing",
		Arguments: map[string]string{"ticker": "BHP"},
	})
	if err != nil {
		t.Fatalf("prompts/get: %v", err)
	}
	text := res.Messages[0].Content.(*sdk.TextContent).Text
	if !strings.Contains(text, defaultBriefingPeriod) {
		t.Errorf("prompt omitted the default period %q:\n%s", defaultBriefingPeriod, text)
	}
}

// A required argument that is missing must fail loudly. Rendering a briefing
// for an empty ticker produces a confident answer about nothing.
func TestPromptsRejectMissingRequiredArguments(t *testing.T) {
	ctx := context.Background()
	session := connectWithSource(t)

	for _, tc := range []struct {
		prompt string
		args   map[string]string
	}{
		{"short_interest_briefing", map[string]string{}},
		{"suburb_housing_brief", map[string]string{"state": "NSW"}},
		{"suburb_housing_brief", map[string]string{"suburb": "Marrickville"}},
	} {
		if _, err := session.GetPrompt(ctx, &sdk.GetPromptParams{
			Name:      tc.prompt,
			Arguments: tc.args,
		}); err == nil {
			t.Errorf("prompts/get %s with args %v succeeded; want an error", tc.prompt, tc.args)
		}
	}
}

// Same reasoning as the resources budget: prompts/list is session preamble.
const maxPromptsListBytes = 3072

func TestPromptsListStaysSmall(t *testing.T) {
	res, err := connectWithSource(t).ListPrompts(context.Background(), nil)
	if err != nil {
		t.Fatalf("prompts/list: %v", err)
	}
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	t.Logf("prompts/list = %d bytes across %d prompts", len(encoded), len(res.Prompts))
	if len(encoded) > maxPromptsListBytes {
		t.Errorf("prompts/list is %d bytes, over the %d-byte budget", len(encoded), maxPromptsListBytes)
	}
}

// Every tool a prompt tells the model to call must exist. A prompt naming a
// renamed tool sends the model to a dead end, and nothing else would catch it.
func TestPromptsOnlyReferenceRegisteredTools(t *testing.T) {
	known := map[string]bool{}
	for _, tool := range Registry() {
		known[tool.Name] = true
	}
	for _, prompt := range Prompts() {
		for _, name := range prompt.Tools {
			if !known[name] {
				t.Errorf("prompt %q references tool %q, which is not in Registry()", prompt.Name, name)
			}
		}
	}
}
