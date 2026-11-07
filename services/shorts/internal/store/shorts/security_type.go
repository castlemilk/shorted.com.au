package shorts

import "github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"

// ClassifySecurity labels an instrument from its ASIC product name, code and
// shares on issue. The rules live in instrument.ClassifySecurity; this wrapper
// keeps the store's call sites unchanged.
func ClassifySecurity(productName, productCode string, sharesOnIssue float64) instrument.SecurityType {
	return instrument.ClassifySecurity(productName, productCode, sharesOnIssue)
}
