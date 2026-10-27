package main

import (
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// TestAddressPriorLiveWindowMatchesSweepWindow pins the store's address-prior
// live window to the collector's listing rollup window. The store owns the SQL
// (housingcrawl's store_test.go covers its shape and behaviour); this guard
// lives here because indexSweepWindowDays is a collector constant.
func TestAddressPriorLiveWindowMatchesSweepWindow(t *testing.T) {
	if housingcrawl.AddressPriorLiveWindow != time.Duration(indexSweepWindowDays)*24*time.Hour {
		t.Errorf("AddressPriorLiveWindow = %s, want the %d-day sweep window every listing rollup uses",
			housingcrawl.AddressPriorLiveWindow, indexSweepWindowDays)
	}
}
