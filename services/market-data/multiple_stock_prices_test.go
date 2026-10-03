package main

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Row errors can arrive after Query succeeds, including after some usable
// prices have already been decoded. They must never become cacheable success.
func TestReadMultipleStockPricesRejectsIncompleteResults(t *testing.T) {
	for _, rowCount := range []int{0, 1} {
		rows := &testStockPriceRows{remaining: rowCount, terminalErr: context.DeadlineExceeded}
		prices, err := readMultipleStockPrices(rows)
		require.ErrorIs(t, err, context.DeadlineExceeded)
		require.Nil(t, prices)
	}
}

func TestReadMultipleStockPricesRejectsDecodeErrors(t *testing.T) {
	want := errors.New("cannot decode NULL close")
	prices, err := readMultipleStockPrices(&testStockPriceRows{remaining: 1, scanErr: want})
	require.ErrorIs(t, err, want)
	require.Nil(t, prices)
}

func TestReadMultipleStockPricesAllowsMissingCoverage(t *testing.T) {
	prices, err := readMultipleStockPrices(&testStockPriceRows{})
	require.NoError(t, err)
	require.NotNil(t, prices)
	require.Empty(t, prices)
}

type testStockPriceRows struct {
	remaining   int
	terminalErr error
	scanErr     error
}

func (r *testStockPriceRows) Next() bool {
	if r.remaining == 0 {
		return false
	}
	r.remaining--
	return true
}

func (r *testStockPriceRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	*(dest[0].(*string)) = "CBA"
	*(dest[1].(*time.Time)) = time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	for _, i := range []int{2, 3, 4, 5} {
		*(dest[i].(*float64)) = 100
	}
	*(dest[6].(*int64)) = 1000
	*(dest[7].(*sql.NullFloat64)) = sql.NullFloat64{}
	*(dest[8].(*sql.NullFloat64)) = sql.NullFloat64{}
	return nil
}

func (r *testStockPriceRows) Err() error { return r.terminalErr }
