package mcp

// admin_market_moves.go: post_market_move and retract_market_move, the admin
// connector's door to market moves (moves:write). They call the same publish
// and retract path as POST /v1/market-moves (services/shorts/internal/services/
// shorts/market_moves.go), so the rules, the caps and the audit trail are one;
// only the credential differs (an administrator's OAuth grant, recorded as
// oauth:<uid>). A post is LIVE on shorted.com.au as soon as the call returns.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// AdminMarketMovesOperator is the optional capability the market-moves tools
// need. The admin server's operator provides it when the store holds moves.
type AdminMarketMovesOperator interface {
	MarketMoves() MarketMovesPoster
}

// MarketMovesPoster posts and retracts moves on behalf of an actor.
type MarketMovesPoster interface {
	PostMarketMove(ctx context.Context, actor string, in PostMarketMoveInput) (MarketMoveToolOutput, error)
	RetractMarketMove(ctx context.Context, actor string, in RetractMarketMoveInput) (MarketMoveToolOutput, error)
}

// MarketMoveRefusal is a post or retraction the server refused, in words the
// model can act on: every field at fault, and whether sending it again may work.
type MarketMoveRefusal struct {
	Code      string
	Message   string
	Fields    []MarketMoveFieldProblem
	Retryable bool
}

// MarketMoveFieldProblem is one field at fault.
type MarketMoveFieldProblem struct {
	Field   string
	Message string
}

func (r *MarketMoveRefusal) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "not done (%s): %s", r.Code, r.Message)
	for _, f := range r.Fields {
		fmt.Fprintf(&b, "\n- %s: %s", f.Field, f.Message)
	}
	if r.Retryable {
		b.WriteString("\nSending the same call again may succeed.")
	}
	return b.String()
}

// MarketMoveSourceInput is one cited source.
type MarketMoveSourceInput struct {
	Title     string `json:"title" jsonschema:"The source's headline or title, plain text."`
	URL       string `json:"url" jsonschema:"The https URL of the source."`
	Publisher string `json:"publisher,omitempty" jsonschema:"Who published it, for example ASX or the AFR."`
}

// PostMarketMoveInput is one move. Its field names are POST /v1/market-moves'
// (TestMarketMoveToolInputMatchesTheHTTPBody holds the two together).
type PostMarketMoveInput struct {
	MoveKey      string                  `json:"move_key" jsonschema:"Your own key for this move: 3 to 128 characters of a-z 0-9 . _ : - (for example 2026-11-07:bhp:iron-ore). Posting the same key again revises the move in place (revision + 1); posting identical content again changes nothing."`
	Kind         string                  `json:"kind" jsonschema:"What moved: stock, index, sector or market."`
	StockCode    string                  `json:"stock_code,omitempty" jsonschema:"Required for kind stock and only for it: the ASX code, for example BHP. Must be a code shorted holds."`
	IndexCode    string                  `json:"index_code,omitempty" jsonschema:"Required for kind index and only for it: the ASX index code, for example XJO."`
	Sector       string                  `json:"sector,omitempty" jsonschema:"Required for kind sector and only for it, for example Materials."`
	RelatedCodes []string                `json:"related_codes,omitempty" jsonschema:"Up to 10 other ASX codes the move names. Each must be a code shorted holds; leave a code out rather than guess."`
	Direction    string                  `json:"direction" jsonschema:"up, down, flat (at most 0.5% either way) or mixed. Must agree with change_pct's sign."`
	ChangePct    *float64                `json:"change_pct,omitempty" jsonschema:"The move in percent, -3.2 for a 3.2% fall. Required for stock and index moves. Leave it out when you do not know it; never send 0 for unknown."`
	Price        *float64                `json:"price,omitempty" jsonschema:"The price, or the index level, at observed_at. Optional."`
	VolumeRatio  *float64                `json:"volume_ratio,omitempty" jsonschema:"Volume against its usual level (2.5 = two and a half times). Optional."`
	Headline     string                  `json:"headline" jsonschema:"8 to 140 characters of plain text: what moved and by how much."`
	Summary      string                  `json:"summary" jsonschema:"20 to 1200 characters of plain text saying why it moved. Line breaks are kept; markdown and HTML are shown as typed."`
	Sources      []MarketMoveSourceInput `json:"sources,omitempty" jsonschema:"Up to 6 https sources for the move."`
	Tags         []string                `json:"tags,omitempty" jsonschema:"Up to 8 tags of a-z 0-9 and -, for example iron-ore."`
	Significance int                     `json:"significance,omitempty" jsonschema:"1 (minor) to 5 (a market-wide event). Default 3. The homepage shows 3 and above."`
	ObservedAt   string                  `json:"observed_at" jsonschema:"When you observed the move, RFC 3339 with an offset. Not in the future and not more than 72 hours ago."`
	Model        string                  `json:"model,omitempty" jsonschema:"The model writing the move, for example claude-opus-5-5. Shown beside the move."`
	RunID        string                  `json:"run_id,omitempty" jsonschema:"Your workflow run's id, for the audit log. Not shown."`
}

// RetractMarketMoveInput names the move to retract.
type RetractMarketMoveInput struct {
	MoveKey string `json:"move_key" jsonschema:"The key the move was posted with."`
	Reason  string `json:"reason,omitempty" jsonschema:"Why, in up to 280 characters. Recorded, not shown."`
}

// MarketMoveToolOutput is the move after the call.
type MarketMoveToolOutput struct {
	Outcome    string `json:"outcome" jsonschema:"created, updated, unchanged or retracted."`
	Status     string `json:"status" jsonschema:"published or retracted."`
	MoveKey    string `json:"move_key"`
	Revision   int32  `json:"revision"`
	ObservedAt string `json:"observed_at"`
	MarketDate string `json:"market_date" jsonschema:"The Sydney date the move is filed under."`
	URL        string `json:"url" jsonschema:"Where the move is drawn on shorted.com.au."`
}

// Tool names, exported for the tests.
const (
	PostMarketMoveTool    = "post_market_move"
	RetractMarketMoveTool = "retract_market_move"
)

func marketMovesAdminTools() []AdminTool {
	return []AdminTool{postMarketMoveTool(), retractMarketMoveTool()}
}

func marketMovesPoster(pub AdminOperator) (MarketMovesPoster, error) {
	op, ok := pub.(AdminMarketMovesOperator)
	if !ok || op.MarketMoves() == nil {
		return nil, errors.New("market moves are not wired on this deployment")
	}
	return op.MarketMoves(), nil
}

func postMarketMoveTool() AdminTool {
	t := AdminTool{Name: PostMarketMoveTool, Scope: ScopeMovesWrite}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Post a market move",
			Description: "Publish one market move to https://shorted.com.au/market-moves, the homepage strip and the stock pages it names. " +
				"LIVE at once, labelled as written by an AI workflow. A move is a stock, an index, a sector or the whole market " +
				"moving, with its figure, the time you observed it and why it moved. Re-post the same move_key to revise it in place " +
				"(for example the closing figure). Every field at fault is reported at once; fix them all and post again. " +
				"Retract a mistaken move with retract_market_move.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in PostMarketMoveInput) (*sdk.CallToolResult, MarketMoveToolOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, MarketMoveToolOutput{}, nil
			}
			poster, err := marketMovesPoster(pub)
			if err != nil {
				return marketMoveToolError(err), MarketMoveToolOutput{}, nil
			}
			out, err := poster.PostMarketMove(ctx, adminActor(req), in)
			if err != nil {
				return marketMoveToolError(err), MarketMoveToolOutput{}, nil
			}
			text := fmt.Sprintf("Market move %s %s (revision %d, filed under %s). Live at %s", out.MoveKey, out.Outcome, out.Revision, out.MarketDate, out.URL)
			if out.Outcome == "unchanged" {
				text = fmt.Sprintf("Market move %s is unchanged: the content matches revision %d. Nothing was written. %s", out.MoveKey, out.Revision, out.URL)
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

func retractMarketMoveTool() AdminTool {
	t := AdminTool{Name: RetractMarketMoveTool, Scope: ScopeMovesWrite}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Retract a market move",
			Description: "Take one market move off shorted.com.au. A retraction is final: the move_key cannot be posted again, so post a " +
				"corrected move under a new key. Retracting a move already retracted changes nothing.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(true), IdempotentHint: true, OpenWorldHint: new(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in RetractMarketMoveInput) (*sdk.CallToolResult, MarketMoveToolOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, MarketMoveToolOutput{}, nil
			}
			poster, err := marketMovesPoster(pub)
			if err != nil {
				return marketMoveToolError(err), MarketMoveToolOutput{}, nil
			}
			out, err := poster.RetractMarketMove(ctx, adminActor(req), in)
			if err != nil {
				return marketMoveToolError(err), MarketMoveToolOutput{}, nil
			}
			text := fmt.Sprintf("Market move %s is retracted and no longer shown.", out.MoveKey)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// marketMoveToolError shows a refusal in full and anything else as one line.
// The store's own errors never reach here: the adapter maps them to refusals.
func marketMoveToolError(err error) *sdk.CallToolResult {
	res := &sdk.CallToolResult{}
	var refusal *MarketMoveRefusal
	if errors.As(err, &refusal) {
		res.SetError(refusal)
		return res
	}
	res.SetError(err)
	return res
}
