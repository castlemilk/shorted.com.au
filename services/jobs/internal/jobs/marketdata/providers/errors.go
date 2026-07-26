package providers

import (
	"errors"
	"fmt"
)

// ErrNoData is a sentinel error indicating a stock has no data available.
// This is an expected condition for delisted stocks, not a real failure.
var ErrNoData = errors.New("no data available")

// NoDataError wraps ErrNoData with symbol-specific context.
type NoDataError struct {
	Symbol string
	Reason string
}

func (e *NoDataError) Error() string {
	return fmt.Sprintf("no data for %s: %s", e.Symbol, e.Reason)
}

func (e *NoDataError) Is(target error) bool {
	return target == ErrNoData
}

// NewNoDataError creates a NoDataError for expected no-data conditions.
func NewNoDataError(symbol, reason string) *NoDataError {
	return &NoDataError{Symbol: symbol, Reason: reason}
}

// IsNoDataError returns true if the error represents an expected no-data condition.
func IsNoDataError(err error) bool {
	return errors.Is(err, ErrNoData)
}
