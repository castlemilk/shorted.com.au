package main

import "sort"

// drop_index.go computes the daily discounting index behind /price-drops.
//
// The whole design turns on ONE choice: the index is the equal-weighted mean of
// per-suburb drop rates, NOT sum(dropped)/sum(active).
//
// Measured 2026-08-16: suburbs with listing data per week ran 115, 124, 88,
// 491, 499 — zero suburbs appear in every week, because the crawl catalog grew
// from ~115 to 500. A pooled ratio over that history measures catalog growth.
// Reconstructed naively the active denominator reads 1,246 -> 19,977 -> 27,301
// -> 60,934 -> 36,397, where the final fall is the 2026-08-13..15 crawl outage.
// Published as a market index that is a crash which did not happen.
//
// Equal weighting makes an added suburb move the mean by 1/N instead of by
// however many listings it brought. TestIndexWeightsSuburbsEqually pins this
// — a pooled ratio yields 0.2942 there where the mean yields 0.254.

// suburbDay is one suburb's contribution to one snapshot date.
type suburbDay struct {
	salCode       string
	stateCode     string  // used when rolling suburbs up to a state grain
	active        int     // deduped physical addresses active that day
	dropped       int     // addresses with a price_drop in the trailing 30d, still active
	medianDropPct float64 // depth of cut within the suburb, 0..1
	sweptRecently bool    // crawled within the prior 48h
}

// indexPoint is one row of housing_drop_index_daily.
type indexPoint struct {
	ActiveAddresses  int
	DroppedAddresses int
	DropRate         float64
	MedianDropPct    float64
	RelistedLower    int
	DelistedCount    int
	PanelSuburbs     int
	CoverageRatio    float64
	IsGap            bool
}

// aggregateIndex folds per-suburb rows into one snapshot point.
//
// minActive excludes suburbs too small to carry a meaningful rate — a
// three-listing suburb reports 33% off a single cut. gapThreshold is the
// coverage ratio below which the day is not a fair reading at all.
func aggregateIndex(rows []suburbDay, minActive int, gapThreshold float64) indexPoint {
	var out indexPoint

	rates := make([]float64, 0, len(rows))
	depths := make([]float64, 0, len(rows))
	swept := 0

	for _, r := range rows {
		// active == 0 would make the rate NaN and poison the whole day's mean.
		// Guarded independently of minActive because minActive's zero value is 0.
		if r.active <= 0 {
			continue
		}
		if r.active < minActive {
			continue // too small to weigh equally with a real suburb
		}
		out.PanelSuburbs++
		out.ActiveAddresses += r.active
		out.DroppedAddresses += r.dropped
		rates = append(rates, float64(r.dropped)/float64(r.active))
		// medianDropPct is 0 when the suburb recorded no drops at all, so a zero is
		// "no depth to report" rather than "a 0% cut". Excluding it keeps the
		// national depth figure from being dragged down by suburbs with no cuts.
		if r.medianDropPct > 0 {
			depths = append(depths, r.medianDropPct)
		}
		if r.sweptRecently {
			swept++
		}
	}

	if out.PanelSuburbs == 0 {
		// No panel is not "zero discounting" — it is no reading.
		out.IsGap = true
		return out
	}

	var sum float64
	for _, v := range rates {
		sum += v
	}
	out.DropRate = sum / float64(len(rates))
	out.MedianDropPct = median(depths)
	// Zero coverage is ALWAYS a gap, whatever the threshold. Without this a
	// gapThreshold of 0 (the Go zero value, i.e. an unwired config field) turns
	// a total crawl outage into a normal-looking reading — the exact failure
	// this file exists to prevent.
	out.CoverageRatio = float64(swept) / float64(out.PanelSuburbs)
	out.IsGap = swept == 0 || out.CoverageRatio < gapThreshold

	return out
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	mid := len(s) / 2
	if len(s)%2 == 1 {
		return s[mid]
	}
	return (s[mid-1] + s[mid]) / 2
}
