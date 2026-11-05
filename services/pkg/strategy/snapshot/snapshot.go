// Package snapshot holds the stored feature row of one stock on one session:
// the input the evaluator reads, written once per session so that a published
// result can be reproduced from what was known that day.
package snapshot

import (
	"encoding/json"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// Row is one stored feature row for one stock on one as-of session.
type Row struct {
	AsOf, BarDate                                        civil.Date
	FeatureSet, StockCode, IneligibleReason, ShortStatus string
	OrdinaryFresh60, IsOrdinary, InASICReport            bool
	ShortReportDate, ShortAvailableDate, CASuspectDate   *civil.Date
	Features                                             Features
	FundamentalsHash                                     string
	Meta                                                 json.RawMessage // name, industry, logo, fallbacks, provenance
}

// Features is the row's features object. The price features are stored under
// fs1 with the view's column names. The dividend field and the short readings
// are stored beside them; their readers fill them in later changes.
type Features struct {
	Bar   Bar                    `json:"bar"`    // the as-of bar
	ExDiv float64                `json:"ex_div"` // ex-dividend cash per share on the as-of session; 0 when none
	FS1   features.PriceFeatures `json:"fs1"`    // keys are the view's column names
	SF0   features.ShortReading  `json:"sf0"`    // the v0 short reading (with its days to cover)
	SF1   features.ShortReading  `json:"sf1"`    // the v1 short reading
}

// Bar is the as-of bar: open, high, low, close, adjusted close and volume.
type Bar struct {
	O   float64 `json:"o"`
	H   float64 `json:"h"`
	L   float64 `json:"l"`
	C   float64 `json:"c"`
	Adj float64 `json:"adj"`
	V   float64 `json:"v"`
}
