package mcp

import (
	"context"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// DataSource is the narrow interface the MCP tools call. It is satisfied by
// *ShortsServer, whose methods are Connect handlers invoked here IN-PROCESS —
// which is precisely why every method listed on it must correspond to a
// VISIBILITY_PUBLIC RPC. See the package doc.
//
// It is narrow deliberately. *ShortsServer implements every rpc on all twelve
// domain services, MintToken among them; naming the handful the tools actually
// need means a tool physically cannot reach the rest, and the interface itself
// is a second, compile-time reading of the surface that
// TestToolsOnlyCallPublicMethods checks at test time.
//
// The signatures are the real Connect handler signatures, copied from the
// domain files in services/shorts/internal/services/shorts — note that several
// of them (GetStock among them) return a bare type from the shortedtypes
// package rather than a <Method>Response wrapper.
type DataSource interface {
	// GetStock: shorts.v1alpha1.StockService.GetStock
	GetStock(context.Context, *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error)
}
