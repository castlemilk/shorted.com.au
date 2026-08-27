package shorts

import (
	"fmt"

	"connectrpc.com/connect"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// validateSuburbMetricKeys is generation-independent handler validation. The
// RPC methods will call it after housing.proto code generation supplies their
// request/response types.
func validateSuburbMetricKeys(metricKeys []string) ([]string, error) {
	if len(metricKeys) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("metric_keys requires at least one key"))
	}
	validated, err := shortsstore.ValidateSuburbMetricKeys(metricKeys)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid metric_keys: %w", err))
	}
	return validated, nil
}

func validateSuburbPredicates(predicates []shortsstore.SuburbMetricPredicateRow) error {
	if err := shortsstore.ValidateSuburbMetricPredicates(predicates); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid predicates: %w", err))
	}
	return nil
}
