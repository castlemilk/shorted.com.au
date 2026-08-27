package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// The generated mocks under services/shorts/internal/services/shorts/mocks
// cover the STORE interface (ShortsStore), not the Connect handlers, so they
// cannot stand in for a DataSource. This is the smallest thing that can:
// it records the request it was handed, which is the half of the contract a
// response assertion alone would miss.
type fakeDataSource struct {
	gotCode string
	stock   *stocksv1alpha1.Stock
	err     error
}

func (f *fakeDataSource) GetStock(_ context.Context, req *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error) {
	f.gotCode = req.Msg.GetProductCode()
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stock), nil
}

var _ DataSource = (*fakeDataSource)(nil)

func TestGetStockPassesUppercasedCodeThrough(t *testing.T) {
	src := &fakeDataSource{stock: &stocksv1alpha1.Stock{
		ProductCode:            "BHP",
		Name:                   "BHP GROUP LIMITED",
		Industry:               "Materials",
		PercentageShorted:      1.25,
		ReportedShortPositions: 63_000_000,
		TotalProductInIssue:    5_040_000_000,
	}}

	res, out, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "  bhp "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The handler must normalise: the store keys on upper-case codes, and an
	// agent will pass whatever the user typed.
	if src.gotCode != "BHP" {
		t.Errorf("passed product code %q to the RPC, want %q", src.gotCode, "BHP")
	}

	if out.Code != "BHP" || out.Name != "BHP GROUP LIMITED" || out.Industry != "Materials" {
		t.Errorf("identity fields not mapped: %+v", out)
	}
	if out.PercentShorted != 1.25 {
		t.Errorf("percent_shorted = %v, want 1.25", out.PercentShorted)
	}
	if out.ReportedShortPositions != 63_000_000 || out.TotalProductInIssue != 5_040_000_000 {
		t.Errorf("share counts not mapped: %+v", out)
	}

	// The text fallback is what non-structured clients render; assert it exists
	// and carries the delay caveat rather than being raw JSON.
	if res == nil || len(res.Content) == 0 {
		t.Fatal("no text content returned — clients that ignore structuredContent would see nothing")
	}
	text, ok := res.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("content[0] is %T, want *mcp.TextContent", res.Content[0])
	}
	if !strings.Contains(text.Text, "BHP") || !strings.Contains(text.Text, "T+4") {
		t.Errorf("text fallback should name the stock and the ASIC delay, got %q", text.Text)
	}
}

func TestGetStockRejectsMalformedCodeWithoutCallingTheRPC(t *testing.T) {
	for _, code := range []string{"", "B", "TOOLONG", "BH-P"} {
		src := &fakeDataSource{stock: &stocksv1alpha1.Stock{}}
		_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: code})
		if err == nil {
			t.Errorf("code %q: expected a validation error", code)
		}
		if src.gotCode != "" {
			t.Errorf("code %q: reached the RPC despite failing validation", code)
		}
	}
}

func TestGetStockTurnsNotFoundIntoAnActionableMessage(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("stock not found: ZZZZ"))}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "ZZZZ"})
	if err == nil {
		t.Fatal("expected an error for an unknown code")
	}
	// The point of the message is that the model can act on it, not that it
	// exists — so assert on the remedy it names.
	if !strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("not-found error should point at a next step, got %q", err.Error())
	}
}

func TestGetStockSurfacesBackendFailuresAsToolErrors(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("database on fire"))}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "BHP"})
	if err == nil {
		t.Fatal("expected an error when the RPC fails")
	}
	if strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("an internal failure must not be reported as a missing stock, got %q", err.Error())
	}
}

// A nil-bodied response should be reported, never rendered as a stock whose
// every field happens to be zero — "0.00% shorted" is a plausible-looking lie.
func TestGetStockDoesNotInventDataFromAnEmptyResponse(t *testing.T) {
	src := &fakeDataSource{stock: nil}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "BHP"})
	if err == nil {
		t.Fatal("expected an error when the RPC returns no stock")
	}
}
