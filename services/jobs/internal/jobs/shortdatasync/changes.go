package shortdatasync

import (
	"slices"
	"strings"
	"time"
)

// changeSet is what one write run changed in shorts: every report date it wrote
// rows for, and every product code on those rows. The revalidation ping sends
// it so the web tier expires only the stocks, market dates and report periods
// that moved (a routine day: one date of ~800 codes), not every stock page on
// the site.
//
// A nil *changeSet records nothing; the shadow and validation paths pass nil.
type changeSet struct {
	dates map[string]struct{}
	codes map[string]struct{}
	// broad is set when the run wrote something it cannot name (an initial
	// load, a file whose date did not parse). The ping then asks for the broad
	// revalidation.
	broad bool
}

// The narrow-revalidation ceilings. Past either, a run names too much to be
// worth naming and the ping falls back to the broad contract: every stock page,
// every market date and every report. A routine day writes one date of ~800
// codes; a range repair or a long catch-up goes broad. The web route applies
// the same two ceilings (web/src/app/api/revalidate/shorts-change.ts,
// SHORTS_CHANGE_LIMITS).
const (
	maxNarrowCodes = 2000
	maxNarrowDates = 45
)

// add records rows written for one report date.
func (c *changeSet) add(date time.Time, rows []shortsRow) {
	if c == nil || len(rows) == 0 {
		return
	}
	if c.dates == nil {
		c.dates = map[string]struct{}{}
		c.codes = map[string]struct{}{}
	}
	c.dates[date.Format("2006-01-02")] = struct{}{}
	for _, r := range rows {
		if code := strings.ToUpper(strings.TrimSpace(r.ProductCode)); code != "" {
			c.codes[code] = struct{}{}
		}
	}
}

// markBroad records that the run changed something it cannot name.
func (c *changeSet) markBroad() {
	if c != nil {
		c.broad = true
	}
}

// merge folds another run phase's changes (the reconcile pass's) into c.
func (c *changeSet) merge(o changeSet) {
	if c == nil {
		return
	}
	if o.broad {
		c.broad = true
	}
	for d := range o.dates {
		if c.dates == nil {
			c.dates = map[string]struct{}{}
			c.codes = map[string]struct{}{}
		}
		c.dates[d] = struct{}{}
	}
	for code := range o.codes {
		if c.codes == nil {
			c.codes = map[string]struct{}{}
		}
		c.codes[code] = struct{}{}
	}
}

// narrow returns the sorted codes and dates when the set can be named, and
// why not otherwise.
func (c *changeSet) narrow() (codes, dates []string, reason string) {
	switch {
	case c == nil:
		return nil, nil, "no change set"
	case c.broad:
		return nil, nil, "the run wrote rows it cannot name"
	case len(c.dates) == 0 || len(c.codes) == 0:
		return nil, nil, "the change set names no stock or no date"
	case len(c.codes) > maxNarrowCodes:
		return nil, nil, "more stocks than the narrow ceiling"
	case len(c.dates) > maxNarrowDates:
		return nil, nil, "more dates than the narrow ceiling"
	}
	codes = make([]string, 0, len(c.codes))
	for code := range c.codes {
		codes = append(codes, code)
	}
	dates = make([]string, 0, len(c.dates))
	for d := range c.dates {
		dates = append(dates, d)
	}
	slices.Sort(codes)
	slices.Sort(dates)
	return codes, dates, ""
}
