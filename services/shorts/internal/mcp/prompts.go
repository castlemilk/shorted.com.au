package mcp

import (
	"context"
	"fmt"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP prompts: entry points that compose several tools into the shape of a
// question a person actually asks.
//
// The bar for adding one is that it must be worth more than calling the tools
// individually. Each prompt here earns that in the same three ways: it names
// the RIGHT tools in the right order (choosing between list_top_shorts,
// screen_stocks and list_squeeze_candidates is the single most common tool
// selection error on this surface), it carries the interpretation rules that
// otherwise have to be rediscovered per answer (T+4, aggregate not
// attributable, derived aggregates only for housing), and it fixes the output
// shape so the answer is a briefing rather than a JSON dump.
//
// They are deliberately few. prompts/list is session preamble in most clients,
// so an unused prompt is a permanent tax.

const defaultBriefingPeriod = "1Y"

// PromptArgument mirrors the SDK type but is declared here so the registry
// stays the single source of truth for what a prompt accepts.
type PromptArgument struct {
	Name        string
	Title       string
	Description string
	Required    bool
}

// Prompt is one registered MCP prompt. Tools lists the tools its rendered text
// tells the model to call; TestPromptsOnlyReferenceRegisteredTools uses it to
// prove a rename cannot leave a prompt pointing at a tool that no longer
// exists — nothing else would catch that, because a prompt is just prose.
type Prompt struct {
	Name        string
	Title       string
	Description string
	Arguments   []PromptArgument
	Tools       []string
	render      func(args map[string]string) (string, error)
}

func (p Prompt) spec() *sdk.Prompt {
	args := make([]*sdk.PromptArgument, 0, len(p.Arguments))
	for _, arg := range p.Arguments {
		args = append(args, &sdk.PromptArgument{
			Name:        arg.Name,
			Title:       arg.Title,
			Description: arg.Description,
			Required:    arg.Required,
		})
	}
	return &sdk.Prompt{
		Name:        p.Name,
		Title:       p.Title,
		Description: p.Description,
		Arguments:   args,
	}
}

// Prompts returns every prompt this server exposes.
func Prompts() []Prompt {
	return []Prompt{
		shortInterestBriefingPrompt(),
		suburbHousingBriefPrompt(),
		marketWrapPrompt(),
	}
}

func registerPrompts(server *sdk.Server) {
	for _, prompt := range Prompts() {
		if prompt.render == nil {
			continue
		}
		server.AddPrompt(prompt.spec(), promptHandler(prompt))
	}
}

func promptHandler(prompt Prompt) sdk.PromptHandler {
	return func(_ context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
		var args map[string]string
		if req != nil && req.Params != nil {
			args = req.Params.Arguments
		}
		text, err := prompt.render(args)
		if err != nil {
			return nil, err
		}
		return &sdk.GetPromptResult{
			Description: prompt.Description,
			Messages: []*sdk.PromptMessage{{
				Role:    "user",
				Content: &sdk.TextContent{Text: text},
			}},
		}, nil
	}
}

// requiredArg fails loudly on a missing value rather than rendering a template
// with a hole in it. A briefing for an empty ticker still produces a confident
// answer — about nothing.
func requiredArg(args map[string]string, name string) (string, error) {
	value := strings.TrimSpace(args[name])
	if value == "" {
		return "", fmt.Errorf("the %q argument is required", name)
	}
	return value, nil
}

func optionalArg(args map[string]string, name, fallback string) string {
	if value := strings.TrimSpace(args[name]); value != "" {
		return value
	}
	return fallback
}

// ---------------------------------------------------------------------------
// short_interest_briefing
// ---------------------------------------------------------------------------

func shortInterestBriefingPrompt() Prompt {
	return Prompt{
		Name:  "short_interest_briefing",
		Title: "Short interest briefing for one ASX stock",
		Description: "Produce a briefing on one ASX-listed company's short interest: where it stands now, " +
			"how it has moved, how it compares with peers, and what news and director trading sit alongside it.",
		Arguments: []PromptArgument{
			{
				Name:        "ticker",
				Title:       "ASX ticker",
				Description: "ASX ticker code, e.g. BHP or LOT.",
				Required:    true,
			},
			{
				Name:        "period",
				Title:       "Lookback window",
				Description: "History window: " + periodList + ". Defaults to " + defaultBriefingPeriod + ".",
			},
		},
		Tools: []string{
			"get_stock", "get_stock_history", "get_peer_comparison",
			"get_director_trades", "get_stock_news",
		},
		render: func(args map[string]string) (string, error) {
			raw, err := requiredArg(args, "ticker")
			if err != nil {
				return "", err
			}
			// Normalise here rather than passing the caller's casing through:
			// the tools take uppercase ASX codes, and a template that says
			// "call get_stock with lot" makes the model guess.
			code, err := normaliseCode(raw)
			if err != nil {
				return "", err
			}
			period, err := normalisePeriod(optionalArg(args, "period", defaultBriefingPeriod))
			if err != nil {
				return "", err
			}

			return fmt.Sprintf(`Brief me on short interest in %[1]s over %[2]s.

Gather the data first, in this order, and do not answer from memory:

1. get_stock with code=%[1]s — the current reported short position and the date it is as at.
2. get_stock_history with code=%[1]s, period=%[2]s — the trend. Note the high, the low, and the direction of the last few observations.
3. get_peer_comparison with code=%[1]s — whether this level is unusual for the industry or ordinary for it.
4. get_director_trades with code=%[1]s — any insider buying or selling in the window.
5. get_stock_news with code=%[1]s — what has been reported about the company recently.

Then write the briefing:

- Open with the headline number and the date it is AS AT. ASIC publishes with a T+4 trading-day delay, so this figure is at least four trading days old — never call it current or live.
- Say whether short interest is rising, falling or flat over %[2]s, and by how much in percentage points.
- Put the level in context: against %[1]s's own history first, then against its peers. Under 1%% is ordinary, above 5%% is elevated, above 10%% is heavily shorted.
- If days to cover is available, use it — a large position in an illiquid stock is a different situation from the same position in a liquid one.
- Connect the movement to the news and director trades only where the timing genuinely lines up. Say "no obvious catalyst" rather than inventing one.
- Note explicitly that these positions are net and aggregate: no individual fund can be identified, and much short interest is hedging rather than a directional bet against the company.

Close with a link to https://shorted.com.au/shorts/%[1]s. Do not give investment advice or a recommendation.`, code, period), nil
		},
	}
}

// ---------------------------------------------------------------------------
// suburb_housing_brief
// ---------------------------------------------------------------------------

func suburbHousingBriefPrompt() Prompt {
	return Prompt{
		Name:  "suburb_housing_brief",
		Title: "Housing brief for one Australian suburb",
		Description: "Produce a brief on one Australian suburb: prices and how they have moved, the " +
			"demographic and socio-economic profile, and current discounting activity — from official " +
			"sources and derived aggregates only.",
		Arguments: []PromptArgument{
			{
				Name:        "state",
				Title:       "State or territory",
				Description: "State or territory code: " + strings.Join(australianStates, ", ") + ".",
				Required:    true,
			},
			{
				Name:        "suburb",
				Title:       "Suburb name",
				Description: "Suburb name, e.g. Marrickville.",
				Required:    true,
			},
		},
		Tools: []string{
			"get_suburb_profile", "get_house_price_series",
			"list_suburb_price_drops", "get_housing_overview",
		},
		render: func(args map[string]string) (string, error) {
			rawState, err := requiredArg(args, "state")
			if err != nil {
				return "", err
			}
			state, err := normaliseState(rawState)
			if err != nil {
				return "", err
			}
			suburb, err := requiredArg(args, "suburb")
			if err != nil {
				return "", err
			}

			return fmt.Sprintf(`Brief me on the housing market in %[2]s, %[1]s.

Gather the data first, in this order:

1. get_suburb_profile with state=%[1]s and suburb=%[2]s — prices, Census profile and any overlays available for this suburb.
2. get_house_price_series for %[1]s — the state-level official series, so the suburb has something to be compared against.
3. list_suburb_price_drops filtered to %[1]s — whether %[2]s is currently seeing discounting, and how that compares with the rest of the state.
4. get_housing_overview — the national backdrop, if the answer needs one.

Then write the brief:

- Lead with the median or typical price for %[2]s and the date it is as at, then how it has moved.
- Compare %[2]s with %[1]s as a whole. A suburb number without its state context invites the reader to over-read it.
- Use the Census and socio-economic profile to explain WHO lives there, not just what it costs.
- If discounting is present, say how much and on what volume of listings. A handful of reductions in a small suburb is noise.

Two constraints that are not stylistic:

- Suburb price data is sparse and uneven — coverage depends on what each state's Valuer-General publishes. Where a figure is missing, say it is not available. Do not interpolate, and do not substitute a neighbouring suburb without saying so.
- Only derived aggregates are available. There are no individual property listings, addresses, agents or photographs on this server, and none can be produced. If the question needs a specific property, say that is out of scope.

Close with a link to the suburb page under https://shorted.com.au/housing/%[3]s/. Do not give property investment advice.`,
				state, suburb, strings.ToLower(state)), nil
		},
	}
}

// ---------------------------------------------------------------------------
// market_wrap
// ---------------------------------------------------------------------------

func marketWrapPrompt() Prompt {
	return Prompt{
		Name:  "market_wrap",
		Title: "ASX short-selling market wrap",
		Description: "Produce a market-wide wrap of ASX short selling: what is most shorted, which " +
			"sectors are carrying the positioning, and where squeeze risk is concentrated.",
		Arguments: []PromptArgument{
			{
				Name:        "period",
				Title:       "Lookback window",
				Description: "Window used for rankings and sector change: " + periodList + ". Defaults to " + defaultBriefingPeriod + ".",
			},
		},
		Tools: []string{
			"list_top_shorts", "get_industry_treemap",
			"list_squeeze_candidates", "list_reports",
		},
		render: func(args map[string]string) (string, error) {
			period, err := normalisePeriod(optionalArg(args, "period", defaultBriefingPeriod))
			if err != nil {
				return "", err
			}

			return fmt.Sprintf(`Give me a wrap of ASX short selling over %[1]s.

Gather the data first:

1. list_top_shorts with period=%[1]s — the leaderboard. This is raw short interest with no filters applied.
2. get_industry_treemap with period=%[1]s — which sectors the positioning sits in, and which have moved.
3. list_squeeze_candidates — where short interest, days to cover and price momentum line up. A stock can top the leaderboard and rank nowhere here; that difference is usually the most interesting thing in the wrap.
4. list_reports — if a published weekly, monthly or yearly report covers this window, read it before writing and cite it rather than restating its analysis as your own.

Then write the wrap:

- Open with the shape of the market: is aggregate short interest concentrated in a few names, or spread?
- Name the sectors carrying the positioning, and say which have moved over %[1]s rather than only which are highest.
- Call out the stocks where the leaderboard and the squeeze ranking disagree, and explain why (usually liquidity — days to cover).
- Date every figure. All of this is ASIC reported positioning published with a T+4 trading-day delay, and it is short INTEREST, not short-sale flow: it says nothing about how much was traded today.
- If a large move looks like a data artefact rather than real positioning — a single enormous jump, or a stock appearing from nowhere — say so instead of narrating it.

Link stocks to https://shorted.com.au/shorts/{CODE}. Do not give investment advice.`, period), nil
		},
	}
}
