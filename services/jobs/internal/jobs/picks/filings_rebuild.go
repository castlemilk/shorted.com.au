package picks

import (
	"sort"
	"time"
)

// The deterministic rebuild of -mode filings (plan fundamentals-coverage.md
// §4.3), as data: which keys this run produces, which it reproduces per
// column, and what that means for what is stored. The SQL that applies it is
// in filings_store.go; planPurge is the same rule computed in Go, for the
// dry-run and refusal logs (the would-purge list) and for tests that check the
// transaction against it.

// filingWriteColumns are the stock_fundamentals columns -mode filings writes,
// in fundamentalsColumns order. Every name is a fundamentalsColumns name.
var filingWriteColumns = []string{"revenue", "net_income", "eps_basic", "eps_diluted"}

// filingRowKey names one stock_fundamentals row.
type filingRowKey struct {
	Code string
	Type string
	End  time.Time
}

func (k filingRowKey) String() string {
	return k.Code + " " + k.Type + " " + k.End.Format("2006-01-02")
}

func (k filingRowKey) less(o filingRowKey) bool {
	if k.Code != o.Code {
		return k.Code < o.Code
	}
	if !k.End.Equal(o.End) {
		return k.End.Before(o.End)
	}
	return k.Type < o.Type
}

// filingFieldKey names one column of one row.
type filingFieldKey struct {
	filingRowKey
	Col string
}

func (k filingFieldKey) String() string { return k.filingRowKey.String() + " " + k.Col }

// storedFiling is one stored row carrying filing data: a filing-source row, or
// a vendor row with filing-filled fields (FilingCols, from field_sources; nil
// before migration 000132).
type storedFiling struct {
	Key        filingRowKey
	Source     string
	FilingCols []string
}

// filingRebuild is one -mode filings write: the COMPLETE set of rows this run
// produces, by code. Anything filing-derived that is stored and not in it is
// removed by the same transaction.
type filingRebuild struct {
	Rows      map[string][]PeriodRow
	FetchedAt time.Time
}

// filingRebuildResult is what the transaction did.
type filingRebuildResult struct {
	Purged      []filingRowKey   // filing rows deleted
	Nulled      []filingFieldKey // filing-filled vendor fields set to NULL
	DocsCleared int              // vendor rows whose document columns were cleared
	Upserted    int              // rows inserted or changed
	Codes       int              // distinct codes among them
	Legacy      bool             // migration 000132 absent: the legacy write path ran
}

func rowKey(code string, r PeriodRow) filingRowKey {
	return filingRowKey{Code: code, Type: r.PeriodType, End: dateOnly(r.PeriodEnd)}
}

func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// keys is every key the rebuild produces, sorted.
func (rb filingRebuild) keys() []filingRowKey {
	return rb.keysWhere(func(PeriodRow) bool { return true })
}

// keysWith is every produced key whose row carries col (the keys that
// REPRODUCE col), sorted.
func (rb filingRebuild) keysWith(col string) []filingRowKey {
	c, ok := columnNamed(col)
	if !ok {
		return nil
	}
	return rb.keysWhere(func(r PeriodRow) bool { return c.get(&r) != nil })
}

func (rb filingRebuild) keysWhere(keep func(PeriodRow) bool) []filingRowKey {
	var out []filingRowKey
	for code, rows := range rb.Rows {
		for _, r := range rows {
			if keep(r) {
				out = append(out, rowKey(code, r))
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].less(out[j]) })
	return out
}

// keyArrays splits keys into the three parallel arrays the SQL unnests.
func keyArrays(keys []filingRowKey) (codes, types, ends []string) {
	codes, types, ends = make([]string, len(keys)), make([]string, len(keys)), make([]string, len(keys))
	for i, k := range keys {
		codes[i], types[i], ends[i] = k.Code, k.Type, k.End.Format("2006-01-02")
	}
	return codes, types, ends
}

// planPurge is the rebuild's removal rule over a stored state, in Go:
//
//   - a filing-source row whose key this run does not produce is deleted;
//   - on any other row, a column field_sources marks asx-filing-extraction
//     whose key does not REPRODUCE that column is set to NULL.
//
// Both lists are sorted. RebuildFilings applies exactly this in SQL, with the
// predicates evaluated at write time.
func planPurge(stored []storedFiling, rows map[string][]PeriodRow) (purge []filingRowKey, null []filingFieldKey) {
	rb := filingRebuild{Rows: rows}
	produced := map[filingRowKey]bool{}
	for _, k := range rb.keys() {
		produced[k] = true
	}
	reproduces := map[string]map[filingRowKey]bool{}
	for _, col := range filingWriteColumns {
		m := map[filingRowKey]bool{}
		for _, k := range rb.keysWith(col) {
			m[k] = true
		}
		reproduces[col] = m
	}
	for _, s := range stored {
		key := filingRowKey{Code: s.Key.Code, Type: s.Key.Type, End: dateOnly(s.Key.End)}
		if s.Source == sourceFiling {
			if !produced[key] {
				purge = append(purge, key)
			}
			continue
		}
		for _, col := range s.FilingCols {
			if m, ok := reproduces[col]; ok && !m[key] {
				null = append(null, filingFieldKey{key, col})
			}
		}
	}
	sort.Slice(purge, func(i, j int) bool { return purge[i].less(purge[j]) })
	sort.Slice(null, func(i, j int) bool {
		if null[i].filingRowKey != null[j].filingRowKey {
			return null[i].less(null[j].filingRowKey)
		}
		return null[i].Col < null[j].Col
	})
	return purge, null
}
