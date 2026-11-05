package backtest

// The diff note a published run carries: what changed in the stored inputs since
// the previously published run of its key, and what that did to the annual
// figures. It is computed when the run is published, from the run's own read of
// the history and the previous run's stored digests and series. Digests cover
// price rows up to the previous run's cut-off, so the note lists rewritten
// history and not ordinary daily appends; ASIC changes come from the revisions
// table, which records every value ASIC later changed in a report already held.

import (
	"sort"
	"time"

	"cloud.google.com/go/civil"
)

// The diff states.
const (
	// DiffNone: there is no previously published run of the key on this engine.
	DiffNone = "none"
	// DiffUnchanged: the previous run read the same input rows.
	DiffUnchanged = "unchanged"
	// DiffChanged: the input rows differ; the lists and the shift say how.
	DiffChanged = "changed"
)

// diffListLimit bounds each list in a note, so one large re-sync cannot grow a
// run's summary without limit. The count is always the full count.
const diffListLimit = 50

// PreviousRun is the previously published run of a key, as the diff note reads it.
type PreviousRun struct {
	RunID int64
	// CutOff is the previous run's digest cut-off: CutOff(its prices_through).
	CutOff civil.Date
	// ASICThrough is the newest ASIC report the previous run read. A revision to a
	// later report did not change anything the previous run held.
	ASICThrough civil.Date
	// ReadAt is when the previous run read its inputs (its batch snapshot). A
	// revision recorded after it changed an input the previous run did not read.
	ReadAt    time.Time
	InputHash string
	// Digests are the previous run's per-code digests, taken at its cut-off.
	Digests map[string]Digest
	// Dates and Equity are the previous run's stored daily equity.
	Dates  []civil.Date
	Equity []float64
}

// ASICRevision is one value ASIC changed in a report the run already held.
type ASICRevision struct {
	ReportDate civil.Date
	Code       string
	// RevisedAt is when the revision was recorded.
	RevisedAt time.Time
}

// DiffNote is a published run's note against its previous run. Its JSON keys are
// the summary's diff object.
type DiffNote struct {
	State         string `json:"state"`
	PreviousRunID int64  `json:"previous_run_id,omitempty"`
	// PreviousCutOff is the cut-off the codes are compared at.
	PreviousCutOff civil.Date `json:"previous_cut_off,omitzero"`
	// PriceRowsRewritten lists the codes whose price or dividend rows up to
	// PreviousCutOff changed. RewrittenCount is the full count.
	PriceRowsRewritten []string `json:"price_rows_rewritten"`
	RewrittenCount     int      `json:"rewritten_count"`
	// ASICRevised lists the product codes of ASIC revisions to reports the previous
	// run read (up to its ASICThrough), recorded after it read its inputs.
	// RevisedCount is the full count. The reconcile records a revision before it
	// repairs the report's row, in separate writes: a snapshot taken between the two
	// reads the old value, and a revision recorded before that snapshot is not listed,
	// though the run's inputs changed. The gap is the time between those two writes,
	// so the list can under-report then; the state and the CAGR shift still show the
	// change.
	ASICRevised  []string `json:"asic_revised"`
	RevisedCount int      `json:"revised_count"`
	// CAGRShiftPP is the change in CAGR over the shared window, in percentage
	// points, current minus previous. It is set only when both are annualised.
	CAGRShiftPP  float64    `json:"cagr_shift_pp"`
	HasCAGRShift bool       `json:"has_cagr_shift"`
	SharedFrom   civil.Date `json:"shared_from,omitzero"`
	SharedTo     civil.Date `json:"shared_to,omitzero"`
}

// NoPrevious is the note of a run with no previously published run to compare with.
// Its lists are [] and its dates absent (omitted), so the stored JSON decodes back.
func NoPrevious() DiffNote {
	return DiffNote{State: DiffNone, PriceRowsRewritten: []string{}, ASICRevised: []string{}}
}

// DiffAgainst builds a run's diff note. in is the run's own read of the history,
// inputHash its input hash, cur its daily equity and revisions the ASIC revisions
// the job read in the same snapshot.
func DiffAgainst(in Inputs, prev *PreviousRun, inputHash string, cur Curve, revisions []ASICRevision) DiffNote {
	if prev == nil || prev.RunID == 0 {
		return NoPrevious()
	}
	d := DiffNote{State: DiffUnchanged, PreviousRunID: prev.RunID, PreviousCutOff: prev.CutOff, PriceRowsRewritten: []string{}, ASICRevised: []string{}}
	if prev.InputHash == inputHash {
		return d
	}
	d.State = DiffChanged

	// The current inputs' digests at the previous cut-off, against the stored ones.
	rewritten := ChangedCodes(prev.Digests, CodeDigests(in, prev.CutOff))
	d.RewrittenCount = len(rewritten)
	d.PriceRowsRewritten = capList(rewritten)

	revised := []string{}
	seen := map[string]bool{}
	for _, r := range revisions {
		if r.ReportDate.After(prev.ASICThrough) || !r.RevisedAt.After(prev.ReadAt) {
			continue
		}
		if !seen[r.Code] {
			seen[r.Code] = true
			revised = append(revised, r.Code)
		}
	}
	sort.Strings(revised)
	d.RevisedCount = len(revised)
	d.ASICRevised = capList(revised)

	prevCurve := Curve{Dates: prev.Dates, Values: prev.Equity}
	if shift, from, to, ok := sharedShift(prevCurve, cur); ok {
		d.CAGRShiftPP, d.HasCAGRShift = shift, true
		d.SharedFrom, d.SharedTo = from, to
	}
	return d
}

// sharedShift is the CAGR of cur minus the CAGR of prev over the sessions both
// curves cover, in percentage points. It is false when they share no span or
// either is not annualised over it.
func sharedShift(prev, cur Curve) (float64, civil.Date, civil.Date, bool) {
	if len(prev.Dates) < 2 || len(cur.Dates) < 2 {
		return 0, civil.Date{}, civil.Date{}, false
	}
	from := prev.Dates[0]
	if cur.Dates[0].After(from) {
		from = cur.Dates[0]
	}
	to := prev.Dates[len(prev.Dates)-1]
	if last := cur.Dates[len(cur.Dates)-1]; last.Before(to) {
		to = last
	}
	if !from.Before(to) {
		return 0, civil.Date{}, civil.Date{}, false
	}
	a, okA := CAGR(within(prev, from, to))
	b, okB := CAGR(within(cur, from, to))
	if !okA || !okB {
		return 0, civil.Date{}, civil.Date{}, false
	}
	return (b - a) * 100, from, to, true
}

// within is the part of c between from and to, both inclusive.
func within(c Curve, from, to civil.Date) Curve {
	var out Curve
	for i, d := range c.Dates {
		if d.Before(from) || d.After(to) {
			continue
		}
		out.Dates = append(out.Dates, d)
		out.Values = append(out.Values, c.Values[i])
	}
	return out
}

// capList is the first diffListLimit entries of a sorted list. It is never nil, so
// an empty list is stored as [] and not null.
func capList(list []string) []string {
	if len(list) <= diffListLimit {
		if list == nil {
			return []string{}
		}
		return list
	}
	return append([]string(nil), list[:diffListLimit]...)
}
