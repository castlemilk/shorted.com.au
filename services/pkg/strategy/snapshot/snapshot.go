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
// are stored beside them, filled by the daily snapshot's session rows
// (services/jobs/internal/jobs/strategies).
type Features struct {
	Bar   Bar                    `json:"bar"`    // the as-of bar
	ExDiv float64                `json:"ex_div"` // ex-dividend cash per share on the as-of session; 0 when none
	FS1   features.PriceFeatures `json:"fs1"`    // keys are the view's column names
	SF0   features.ShortReading  `json:"sf0"`    // the v0 short reading (with its days to cover)
	SF1   features.ShortReading  `json:"sf1"`    // the v1 short reading
	// CASuspects are the corporate-action suspects known by the session, each
	// with the session it became known (ca_known_at). The paper track reads the
	// suspects it admits and blocks from them, with the batch's own rules, so it
	// needs each suspect's known date, which the ca_suspect_date column does not
	// carry. Every row written after this field was added carries the key ca_known
	// (null when none is known); rows written before it do not, and the paper
	// track does not start on one (paper.go, the start rule).
	CASuspects []CAKnown `json:"ca_known,omitempty"`
}

// CAKnown is one corporate-action suspect known by a session: the bar it sits
// on and the session it became known.
type CAKnown struct {
	Date    civil.Date `json:"date"`
	KnownAt civil.Date `json:"known_at"`
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

// MarshalJSON writes fs1 as null when the row carries no price features. The
// zero civil.Date encodes as "0000-00-00", which no reader can parse back, so a
// code with too little history would make every later session's read fail.
func (f Features) MarshalJSON() ([]byte, error) {
	type wire struct {
		Bar   Bar                     `json:"bar"`
		ExDiv float64                 `json:"ex_div"`
		FS1   *features.PriceFeatures `json:"fs1"`
		SF0   features.ShortReading   `json:"sf0"`
		SF1   features.ShortReading   `json:"sf1"`
		// Always written, null when no suspect is known: the key marks a row
		// written after the suspects were stored (the paper track's start rule).
		CAKnown []CAKnown `json:"ca_known"`
	}
	w := wire{Bar: f.Bar, ExDiv: f.ExDiv, SF0: f.SF0, SF1: f.SF1, CAKnown: f.CASuspects}
	if !f.FS1.AsOf.IsZero() {
		fs1 := f.FS1
		w.FS1 = &fs1
	}
	return json.Marshal(w)
}
