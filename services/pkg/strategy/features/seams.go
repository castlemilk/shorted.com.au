package features

import (
	"encoding/json"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The value types the feature pipeline's inputs and stored rows carry. Each is
// filled by its reader and its feature function in a later change; the fields
// here are the ones those readers and functions name, so a later change adds
// fields and never renames these.

// ASICRow is one shorts row: a product code's reported short position on one
// ASIC report date. A code absent from a report has no row here; the zero rows
// of the report are kept by the reader, so Positions can be zero.
type ASICRow struct {
	Code       string
	ReportDate civil.Date
	Product    string   // PRODUCT: the ASIC product name, which the instrument classifier reads
	Positions  float64  // REPORTED_SHORT_POSITIONS
	Issued     float64  // TOTAL_PRODUCT_IN_ISSUE
	Percent    *float64 // the reported percentage; nil is SQL NULL
}

// ReportIngest is one asic_report_ingests row: how much of ASIC's file for a
// report date reached shorts.
type ReportIngest struct {
	ReportDate civil.Date
	FileRows   *int // distinct codes parsed from the file; nil when not recorded
	LoadedRows int  // of those codes, the ones present in shorts after the write
}

// Dividend is one dividend_history row: the cash per share paid for the
// ex-date, unadjusted.
type Dividend struct {
	ExDate         civil.Date
	AmountPerShare float64
}

// RatePoint is one month of the cash rate target, after forward-filling.
type RatePoint struct {
	Date civil.Date
	Rate float64
}

// ShortReading is a stock's short-interest reading on one session: the feature
// set's view of the latest usable ASIC report. Status is the short_status the
// evaluator reads; the dates are nil when the reading has no report. Reason
// names why the status is unavailable or stale; DaysToCoverReason names why
// DaysToCover is unknown. InReport says whether the code has a row in the report
// the reading reads, and is nil when no report backs the reading.
type ShortReading struct {
	Status            string      `json:"status"`
	ReportDate        *civil.Date `json:"report_date"`
	AvailableDate     *civil.Date `json:"available_date"`
	Pct               *float64    `json:"pct"`
	Positions         *float64    `json:"positions"`
	DaysToCover       *float64    `json:"days_to_cover"`
	InReport          *bool       `json:"in_report,omitempty"`
	Reason            string      `json:"reason,omitempty"`
	DaysToCoverReason string      `json:"days_to_cover_reason,omitempty"`
}

// Fundamentals is one stock's fundamentals as the feature row carries them: the
// provenance-free JSON blob and its SHA-256. Hash is what the stored row keeps;
// the blob is what the evaluator reads.
type Fundamentals struct {
	Hash string          `json:"hash"`
	Blob json.RawMessage `json:"blob,omitempty"`
}

// FundamentalsBody is the fundamentals a feature row freezes: the growth
// row with its appended 000132 columns, the quality row and the valuation
// inputs. It carries no provenance timestamp, so the same figures always
// encode to the same bytes and hash to the same blob. Fundamentals.Blob is its
// JSON encoding; the pipeline decodes it back.
type FundamentalsBody struct {
	Growth          *engine.Growth          `json:"growth,omitempty"`
	Quality         *engine.Quality         `json:"quality,omitempty"`
	ValuationInputs *engine.ValuationInputs `json:"valuation_inputs,omitempty"`
}
