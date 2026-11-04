package shorts

import (
	"context"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The stock inspector's per-fund comparison (spec 14.10): each index fund's own
// change in one stock's shares over the fund window, read with the same pairing
// and pricing as the map's index fund change (pairsFor, changePrice),
// so a fund's line here and its share of the map's total agree.

// fundStockChange is one index fund's comparison of one stock. The has_ flags say
// which figures the files state: the start is known only for a fund compared over
// the window.
type fundStockChange struct {
	startDate, endDate                string
	hasStartDate, hasEndDate          bool
	startUnits, endUnits              float64
	hasStartUnits, hasEndUnits        bool
	unitsChange, changeValueAUD       float64
	hasUnitsChange, hasChangeValueAUD bool
}

// fileUnits is a file's shares of a stock. A file with no row for the stock holds
// none there, so zero is stated; a row without units states no shares, so none is
// known.
func fileUnits(byFile map[int64]*shortsstore.FundSnapshotHoldingRow, id int64) (float64, bool) {
	r, ok := byFile[id]
	if !ok {
		return 0, true
	}
	if r.Units == nil {
		return 0, false
	}
	return *r.Units, true
}

// fundStockFile is a fund's file with the id, or nil.
func fundStockFile(f *fundFlowFund, id int64) *shortsstore.FundSnapshotRow {
	for i := range f.files {
		if f.files[i].ID == id {
			return &f.files[i]
		}
	}
	return nil
}

// stockFundChanges is each compared index fund's change in one stock over the
// window, keyed by institution slug and fund name. The fund pairs are the map's
// (pairsFor), each read as its own group through the map's reader, so a fund's
// change, its price and its exclusion are the map's own for that pair: the map's
// fund_flow_aud is the sum of these per-fund values. A fund with no end file has no
// figures; one with no earlier file to start from has its end figures only.
func stockFundChanges(ctx context.Context, idx *fundIndex, store fundFlowReader, code, from, to string) (map[string]fundStockChange, error) {
	out := map[string]fundStockChange{}
	w := idx.pairsFor(from, to)
	if len(w.endIDs) == 0 || store == nil {
		return out, nil
	}
	pairs := pairsByGroup(w.pairs)
	// The compared pair of each end file, by its id.
	pairOfEnd := make(map[int64]int, len(pairs))
	for i, p := range pairs {
		pairOfEnd[p.To] = i
	}
	endRows, err := store.FundSnapshotHoldings(ctx, w.endIDs, code)
	if err != nil {
		return nil, err
	}
	endByFile := map[int64]*shortsstore.FundSnapshotHoldingRow{}
	for i := range endRows {
		if endRows[i].StockCode == code {
			endByFile[endRows[i].SnapshotID] = &endRows[i]
		}
	}
	byGroup := map[int32]shortsstore.FundHoldingChangeRow{}
	if len(pairs) > 0 {
		changes, err := store.FundHoldingChanges(ctx, pairs, []string{code})
		if err != nil {
			return nil, err
		}
		for _, r := range changes {
			if r.StockCode == code {
				byGroup[r.Group] = r
			}
		}
	}
	for _, endID := range w.endIDs {
		f := idx.fundBySnap[endID]
		if f == nil || f.sourceKind != "etf" {
			continue
		}
		end := fundStockFile(f, endID)
		if end == nil {
			continue
		}
		c := fundStockChange{endDate: end.AsAt, hasEndDate: true}
		c.endUnits, c.hasEndUnits = fileUnits(endByFile, endID)
		if i, compared := pairOfEnd[endID]; compared {
			if start := fundStockFile(f, pairs[i].From); start != nil {
				c.startDate, c.hasStartDate = start.AsAt, true
			}
			// A side with no row for the stock holds none there; a row states its units or not.
			c.startUnits, c.hasStartUnits = 0, true
			row, hasRow := byGroup[int32(i)]
			if hasRow && row.RowFrom {
				c.startUnits, c.hasStartUnits = row.UnitsFrom, row.HasUnitsFrom
			}
			if c.hasStartUnits && c.hasEndUnits {
				c.unitsChange, c.hasUnitsChange = c.endUnits-c.startUnits, true
			}
			// The change valued at this fund's own later file's price, the start's when the
			// position has left it (changePrice), the price the map's fund_flow_aud sums. No
			// row means no shares on either side, so the change is zero at any price.
			if c.hasUnitsChange {
				price, ok := 0.0, true
				if hasRow {
					price, ok = changePrice(row)
				}
				if ok {
					c.changeValueAUD, c.hasChangeValueAUD = c.unitsChange*price, true
				}
			}
		}
		out[f.slug+"|"+f.name] = c
	}
	return out, nil
}

// attachFundChanges sets each index fund's comparison on the series. A super
// option has none.
func attachFundChanges(out *shortsv1alpha1.GetStockFundSeriesResponse, changes map[string]fundStockChange) {
	for _, f := range out.Funds {
		if f.SourceKind != "etf" {
			continue
		}
		c, ok := changes[f.InstitutionSlug+"|"+f.FundName]
		if !ok {
			continue
		}
		f.StartDate, f.HasStartDate = c.startDate, c.hasStartDate
		f.StartUnits, f.HasStartUnits = c.startUnits, c.hasStartUnits
		f.EndDate, f.HasEndDate = c.endDate, c.hasEndDate
		f.EndUnits, f.HasEndUnits = c.endUnits, c.hasEndUnits
		f.UnitsChange, f.HasUnitsChange = c.unitsChange, c.hasUnitsChange
		f.ChangeValueAud, f.HasChangeValueAud = c.changeValueAUD, c.hasChangeValueAUD
	}
}
