package main

import "testing"

// ABS publishes RES_DWELL from 2002-Q1. The collector asked for 2015-Q1 until
// 2026-08-26, silently discarding 52 quarters for every region and dwelling
// type; the capital pages chart the full history, so a narrowed window here is
// a data-loss regression rather than a tuning choice.
func TestRESDWELLHistoryBeginsAtABSCoverageStart(t *testing.T) {
	if absRESDWELLStartPeriod != "2002-Q1" {
		t.Fatalf("RES_DWELL start period = %q, want 2002-Q1", absRESDWELLStartPeriod)
	}
}
