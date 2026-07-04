package shorts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const verdictMaxCodeLength = 10

// Component weights of the composite verdict. Must sum to 1.
const (
	verdictWeightShortTrend      = 0.30
	verdictWeightShortLevel      = 0.15
	verdictWeightDirectorSignal  = 0.25
	verdictWeightSentiment       = 0.20
	verdictWeightSqueezePressure = 0.10
)

// GetStockVerdict computes a composite bear-vs-bull verdict (-100..100) for a
// single stock from the screener materialized view.
func (s *ShortsServer) GetStockVerdict(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockVerdictRequest]) (*connect.Response[shortsv1alpha1.GetStockVerdictResponse], error) {
	productCode := strings.ToUpper(strings.TrimSpace(req.Msg.ProductCode))
	if productCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code is required"))
	}
	if len(productCode) > verdictMaxCodeLength {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code must be at most %d characters", verdictMaxCodeLength))
	}
	for _, r := range productCode {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_code must be alphanumeric"))
		}
	}

	s.logger.Debugf("stock verdict: product_code=%s", productCode)

	cacheKey := s.cache.GetStockVerdictKey(productCode)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		inputs, err := s.store.GetStockVerdictInputs(productCode)
		if err != nil {
			return nil, err
		}
		return buildVerdictResponse(productCode, inputs), nil
	})

	if err != nil {
		if errors.Is(err, shortsstore.ErrVerdictStockNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", productCode))
		}
		s.logger.Errorf("database error in GetStockVerdict: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock verdict"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetStockVerdictResponse)
	return connect.NewResponse(response), nil
}

// buildVerdictResponse normalizes the raw screener inputs into weighted
// components and the composite score. All component scores are -1..1 with
// bullish positive.
func buildVerdictResponse(productCode string, in *shortsstore.VerdictInputs) *shortsv1alpha1.GetStockVerdictResponse {
	// Shorts building over the last 4 weeks = bearish
	shortTrend := clamp(-in.ShortPctChange4w/3.0, -1, 1)
	// High absolute short interest = standing bearish pressure (never bullish)
	shortLevel := clamp(-(in.ShortPct / 15.0), -1, 0)
	// Net director buying (A$) = insider conviction
	directorSignal := clamp(in.NetDirectorBuyValue/1_000_000, -1, 1)
	// News sentiment is already -1..1; clamp defensively
	sentiment := clamp(in.AvgSentiment, -1, 1)
	// Crowded shorts are contrarian-bullish fuel (half-strength, never bearish)
	squeezePressure := math.Min(math.Max(in.DaysToCover, 0)/10.0, 1) * 0.5

	components := []*shortsv1alpha1.VerdictComponent{
		newVerdictComponent("short_trend", shortTrend, verdictWeightShortTrend),
		newVerdictComponent("short_level", shortLevel, verdictWeightShortLevel),
		newVerdictComponent("director_signal", directorSignal, verdictWeightDirectorSignal),
		newVerdictComponent("sentiment", sentiment, verdictWeightSentiment),
		newVerdictComponent("squeeze_pressure", squeezePressure, verdictWeightSqueezePressure),
	}

	var composite float64
	for _, c := range components {
		composite += c.Contribution
	}
	composite = round1(composite)

	return &shortsv1alpha1.GetStockVerdictResponse{
		ProductCode: productCode,
		Composite:   composite,
		Label:       verdictLabelFor(composite),
		Components:  components,
	}
}

func newVerdictComponent(name string, score, weight float64) *shortsv1alpha1.VerdictComponent {
	return &shortsv1alpha1.VerdictComponent{
		Name:         name,
		Score:        score,
		Weight:       weight,
		Contribution: round1(100 * weight * score),
	}
}

// verdictLabelFor bands the composite score:
// STRONG_BEARISH <= -40 < BEARISH <= -10 < NEUTRAL < 10 <= BULLISH < 40 <= STRONG_BULLISH
func verdictLabelFor(composite float64) shortsv1alpha1.VerdictLabel {
	switch {
	case composite <= -40:
		return shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BEARISH
	case composite <= -10:
		return shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BEARISH
	case composite < 10:
		return shortsv1alpha1.VerdictLabel_VERDICT_LABEL_NEUTRAL
	case composite < 40:
		return shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BULLISH
	default:
		return shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BULLISH
	}
}

func clamp(v, lo, hi float64) float64 {
	return math.Min(math.Max(v, lo), hi)
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
