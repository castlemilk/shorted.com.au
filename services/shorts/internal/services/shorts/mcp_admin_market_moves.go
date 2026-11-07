package shorts

// mcp_admin_market_moves.go: the adapter behind the admin post_market_move and
// retract_market_move tools (internal/mcp/admin_market_moves.go). It hands the
// tool's input to the same PublishMarketMove / RetractMarketMove the HTTP
// endpoint calls, and turns a refusal into the tool's refusal type, field by
// field. Nothing about a move is decided here.

import (
	"context"
	"errors"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// The admin server's operator provides the market-moves capability.
var _ mcp.AdminMarketMovesOperator = (*adminMCPSource)(nil)

// MarketMoves returns the poster, or nil when the store holds no moves.
func (a *adminMCPSource) MarketMoves() mcp.MarketMovesPoster {
	if a == nil || a.server == nil || a.server.marketMoves == nil {
		return nil
	}
	return marketMovesToolAdapter{server: a.server}
}

type marketMovesToolAdapter struct {
	server *ShortsServer
}

// PostMarketMove posts the tool's move.
func (a marketMovesToolAdapter) PostMarketMove(ctx context.Context, actor string, in mcp.PostMarketMoveInput) (mcp.MarketMoveToolOutput, error) {
	res, err := a.server.PublishMarketMove(ctx, actor, marketMoveInputFromTool(in))
	if err != nil {
		return mcp.MarketMoveToolOutput{}, marketMoveRefusal(err)
	}
	return marketMoveToolOutput(res), nil
}

// RetractMarketMove retracts the tool's move.
func (a marketMovesToolAdapter) RetractMarketMove(ctx context.Context, actor string, in mcp.RetractMarketMoveInput) (mcp.MarketMoveToolOutput, error) {
	res, err := a.server.RetractMarketMove(ctx, actor, in.MoveKey, in.Reason)
	if err != nil {
		return mcp.MarketMoveToolOutput{}, marketMoveRefusal(err)
	}
	return marketMoveToolOutput(res), nil
}

// marketMoveInputFromTool copies the tool's input field by field. The two types
// carry the same JSON names (TestMarketMoveToolInputMatchesTheHTTPBody).
func marketMoveInputFromTool(in mcp.PostMarketMoveInput) MarketMoveInput {
	out := MarketMoveInput{
		MoveKey: in.MoveKey, Kind: in.Kind, StockCode: in.StockCode, IndexCode: in.IndexCode, Sector: in.Sector,
		RelatedCodes: in.RelatedCodes, Direction: in.Direction,
		ChangePct: in.ChangePct, Price: in.Price, VolumeRatio: in.VolumeRatio,
		Headline: in.Headline, Summary: in.Summary, Tags: in.Tags, Significance: in.Significance,
		ObservedAt: in.ObservedAt, Model: in.Model, RunID: in.RunID,
	}
	for _, s := range in.Sources {
		out.Sources = append(out.Sources, MarketMoveSource{Title: s.Title, URL: s.URL, Publisher: s.Publisher})
	}
	return out
}

func marketMoveToolOutput(res *MarketMoveResult) mcp.MarketMoveToolOutput {
	return mcp.MarketMoveToolOutput{
		Outcome:    res.Outcome,
		Status:     res.Status,
		MoveKey:    res.Move.GetMoveKey(),
		Revision:   res.Move.GetRevision(),
		ObservedAt: res.Move.GetObservedAt(),
		MarketDate: res.Move.GetMarketDate(),
		URL:        res.URL,
	}
}

// marketMoveRefusal converts the core's refusal; anything else (there is
// nothing else today) reads as unavailable.
func marketMoveRefusal(err error) error {
	var me *MarketMoveError
	if !errors.As(err, &me) {
		me = marketMovesUnavailable()
	}
	out := &mcp.MarketMoveRefusal{Code: me.Code, Message: me.Message, Retryable: me.Retryable}
	for _, f := range me.Fields {
		out.Fields = append(out.Fields, mcp.MarketMoveFieldProblem{Field: f.Field, Message: f.Message})
	}
	return out
}
