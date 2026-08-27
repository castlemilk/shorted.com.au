package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// Columnar suburb delivery for the housing map.
//
// The map colours ONE metric at a time, but /housing/[state] used to ship every
// suburb's full row to do it: 3.66 MB for NSW's 4,544 suburbs, refetched on
// every "Colour by" switch. These three RPCs split that apart — a stable index
// (cacheable, rarely changes), per-metric packed float columns aligned to it
// (~18 KB per metric for NSW), and filtering that answers with a bitset instead
// of rows (~2 KB for a state) so the client can mask geometry it already holds.
//
// `index_version` is the contract between them: a column or mask is only
// meaningful against the index ordering it was built for, so every response
// carries the version and a client that sees a change must refetch the index.

func normalizeStateCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

func (s *ShortsServer) GetSuburbIndex(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetSuburbIndexRequest],
) (*connect.Response[shortsv1alpha1.GetSuburbIndexResponse], error) {
	stateCode := normalizeStateCode(req.Msg.GetStateCode())
	if stateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}

	result, err := s.store.GetSuburbIndex(stateCode)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	suburbs := make([]*shortsv1alpha1.SuburbIndexEntry, 0, len(result.Suburbs))
	for _, row := range result.Suburbs {
		suburbs = append(suburbs, &shortsv1alpha1.SuburbIndexEntry{
			SalCode:  row.SALCode,
			SalName:  row.SALName,
			Postcode: row.Postcode,
		})
	}

	return connect.NewResponse(&shortsv1alpha1.GetSuburbIndexResponse{
		Suburbs:      suburbs,
		IndexVersion: result.IndexVersion,
	}), nil
}

func (s *ShortsServer) GetSuburbMetricColumns(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetSuburbMetricColumnsRequest],
) (*connect.Response[shortsv1alpha1.GetSuburbMetricColumnsResponse], error) {
	stateCode := normalizeStateCode(req.Msg.GetStateCode())
	if stateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}
	// Keys are validated against the closed server registry before they reach
	// the store: a caller string must never select a column.
	metricKeys, err := validateSuburbMetricKeys(req.Msg.GetMetricKeys())
	if err != nil {
		return nil, err
	}

	result, err := s.store.GetSuburbMetricColumns(stateCode, metricKeys)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	columns := make([]*shortsv1alpha1.SuburbMetricColumn, 0, len(result.Columns))
	for _, column := range result.Columns {
		columns = append(columns, &shortsv1alpha1.SuburbMetricColumn{
			MetricKey: column.Key,
			Values:    column.Values,
			// NullMask travels alongside Values rather than encoding absence in
			// the value: 0 is a legitimate reading for several metrics (a
			// suburb genuinely 0% below 2 m, a decile that does not exist), so
			// a sentinel would make "no data" and "zero" indistinguishable.
			NullMask:       column.NullMask,
			CategoryLabels: column.CategoryLabels,
		})
	}

	return connect.NewResponse(&shortsv1alpha1.GetSuburbMetricColumnsResponse{
		Columns:      columns,
		IndexVersion: result.IndexVersion,
	}), nil
}

func (s *ShortsServer) FilterSuburbs(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.FilterSuburbsRequest],
) (*connect.Response[shortsv1alpha1.FilterSuburbsResponse], error) {
	stateCode := normalizeStateCode(req.Msg.GetStateCode())
	if stateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}

	msgPredicates := req.Msg.GetPredicates()
	if len(msgPredicates) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("predicates requires at least one predicate"))
	}

	predicates := make([]shortsstore.SuburbMetricPredicateRow, 0, len(msgPredicates))
	for _, predicate := range msgPredicates {
		row := shortsstore.SuburbMetricPredicateRow{MetricKey: predicate.GetMetricKey()}
		if predicate.Min != nil {
			min := predicate.GetMin()
			row.Min = &min
		}
		if predicate.Max != nil {
			max := predicate.GetMax()
			row.Max = &max
		}
		predicates = append(predicates, row)
	}
	if err := validateSuburbPredicates(predicates); err != nil {
		return nil, err
	}

	result, err := s.store.FilterSuburbs(stateCode, predicates)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&shortsv1alpha1.FilterSuburbsResponse{
		MatchMask:    result.MatchMask,
		MatchCount:   result.MatchCount,
		IndexVersion: result.IndexVersion,
	}), nil
}
