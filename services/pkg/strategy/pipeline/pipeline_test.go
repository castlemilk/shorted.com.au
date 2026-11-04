package pipeline

import "testing"

// Inputs is written against by the backtest and the live path. This compiles
// only while every field of the seam is present with its declared type.
func TestInputsCarriesTheSeamFields(t *testing.T) {
	in := Inputs{
		Codes:        nil,
		Bars:         nil,
		XJO:          nil,
		XJT:          nil,
		ASIC:         nil,
		Ingests:      nil,
		ETPSet:       nil,
		Names:        nil,
		Dividends:    nil,
		CashRate:     nil,
		Fundamentals: nil,
	}
	if in.Codes != nil || in.Dividends != nil {
		t.Fatal("zero Inputs must have no codes or dividends")
	}
}
