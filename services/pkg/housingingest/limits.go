package housingingest

// Caps on one PushSweep and on each listing field. The server
// (services/shorts/internal/ingest) enforces them, and the rig sanitises to them before
// it pushes (sanitize.go). limits_test.go pins the literal values, so changing one
// without the other fails a test.
const (
	MaxListingsPerSweep = 2000
	MaxPagesPerSweep    = 50
	MaxKeyBytes         = 300
	MaxJobIDBytes       = 128
	MaxAttempt          = 10000
	MaxSuburbBytes      = 100
	MaxStateBytes       = 10
	MaxPostcodeBytes    = 10
	MaxListingIDBytes   = 200
	MaxAddressBytes     = 300
	MaxURLBytes         = 2048
	MaxPropertyBytes    = 100
	MaxPriceTextBytes   = 200
	MaxKindBytes        = 20
	MaxStatusBytes      = 20
	MaxAgencyIDBytes    = 100
	MaxAgencyNameBytes  = 200
	MaxAgentNames       = 20
	MaxAgentNameBytes   = 200
	MaxRevisionBytes    = 100
	MaxCycleIDBytes     = 128
	MaxCountValue       = 1_000_000
	MaxBedroomsValue    = 100
	MaxLandSizeSqm      = 10_000_000
)

// ValidListingStatus is the status vocabulary housingcrawl reads. "" is unknown.
var ValidListingStatus = map[string]bool{"": true, "for_sale": true, "under_offer": true, "sold": true, "withdrawn": true}

// ValidPriceKind is the price-kind vocabulary housingcrawl reads. "" is unknown.
var ValidPriceKind = map[string]bool{
	"": true, "fixed": true, "range_low": true, "range_high": true,
	"offers_over": true, "auction": true, "poa": true, "unknown": true,
}
