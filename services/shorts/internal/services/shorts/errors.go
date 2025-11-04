package shorts

import (
	"errors"
)

// Common errors
var (
	ErrStockNotFound = errors.New("stock not found")
	ErrInvalidPeriod = errors.New("invalid period")
	ErrDatabaseError = errors.New("database error")
)
