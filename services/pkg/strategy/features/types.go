package features

import "cloud.google.com/go/civil"

// Bar is one stock_prices row as the short-interest and corporate-action
// features read it. Callers pass bars date ascending and already drop rows whose
// close is not a usable price (the price filter the picker features apply).
// Volume is the share count; a NULL volume reads as zero.
type Bar struct {
	Date     civil.Date
	Open     float64
	High     float64
	Low      float64
	Close    float64
	AdjClose float64
	Volume   float64
}

// ASICRow is one shorts row: a product code's reported short position on one
// ASIC report date. Zero rows are kept, so Positions can be zero. Product is the
// ASIC product name, which the instrument classifier reads.
type ASICRow struct {
	Code       string
	ReportDate civil.Date
	Product    string
	Positions  float64  // REPORTED_SHORT_POSITIONS
	Issued     float64  // TOTAL_PRODUCT_IN_ISSUE; zero when not recorded
	Percent    *float64 // reported percentage; nil is SQL NULL
}

// ReportIngest is one asic_report_ingests row: how much of ASIC's file for a
// report date reached shorts.
type ReportIngest struct {
	ReportDate civil.Date
	FileRows   *int // distinct codes parsed from the file; nil when not recorded
	LoadedRows int  // codes present in shorts after the write
}
