package pgsource

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// MergeMetadata fills what a candidate lacks, by code, and never overwrites a
// value the candidate already carries.
func TestMergeMetadataFillsOnlyWhatIsMissing(t *testing.T) {
	mc := 5e9
	meta := map[string]CompanyMeta{
		"BHP": {Name: "BHP Group Limited", Industry: "Materials", LogoURL: "https://x/bhp.png", MarketCap: &mc},
		"CBA": {Name: "Commonwealth Bank", Industry: "Banks", LogoURL: "https://x/cba.png"},
	}
	own := 7e9
	cands := []engine.Candidate{
		{StockCode: "BHP"}, // gets everything
		{StockCode: "CBA", CompanyName: "CBA Own", MarketCap: &own}, // keeps its name and market cap
		{StockCode: "ZZZ", Industry: "Energy"},                      // not in the metadata: untouched
	}
	MergeMetadata(cands, meta)

	bhp := cands[0]
	if bhp.CompanyName != "BHP Group Limited" || bhp.Industry != "Materials" || bhp.LogoURL != "https://x/bhp.png" {
		t.Errorf("BHP = %+v", bhp)
	}
	if bhp.MarketCap == nil || *bhp.MarketCap != mc {
		t.Errorf("BHP market cap = %v, want %v", bhp.MarketCap, mc)
	}
	*bhp.MarketCap = 1 // a write through the candidate's pointer must not reach the metadata
	if *meta["BHP"].MarketCap != 5e9 {
		t.Error("the candidate's market cap aliases the metadata's")
	}

	cba := cands[1]
	if cba.CompanyName != "CBA Own" || *cba.MarketCap != 7e9 {
		t.Errorf("CBA overwrote its own fields: %+v", cba)
	}
	if cba.Industry != "Banks" || cba.LogoURL != "https://x/cba.png" {
		t.Errorf("CBA missing industry or logo: %+v", cba)
	}
	if zzz := cands[2]; zzz.Industry != "Energy" || zzz.CompanyName != "" || zzz.MarketCap != nil {
		t.Errorf("a code outside the metadata changed: %+v", zzz)
	}
}

// A nil map changes nothing.
func TestMergeMetadataNilIsANoOp(t *testing.T) {
	cands := []engine.Candidate{{StockCode: "BHP", Industry: "Materials"}}
	MergeMetadata(cands, nil)
	if cands[0].Industry != "Materials" || cands[0].CompanyName != "" {
		t.Errorf("nil metadata changed the candidate: %+v", cands[0])
	}
}
