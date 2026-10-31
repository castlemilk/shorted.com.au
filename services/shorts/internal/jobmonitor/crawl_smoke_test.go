package jobmonitor

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestCrawlSmokeArgsAreClosedAndOnlyEnqueueOneSuburb(t *testing.T) {
	got := crawlSmokeArgs("smoke-20261031T100000Z-0a1b2c3d", "bondi")
	want := []string{"-mode", "server-enqueue", "-selection", "smoke", "-run-id", "smoke-20261031T100000Z-0a1b2c3d", "-suburb", "bondi"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	// With no suburb the collector picks the stalest one: the flag is left out, not blank.
	got = crawlSmokeArgs("smoke-20261031T100000Z-0a1b2c3d", "")
	for _, a := range got {
		if a == "-suburb" {
			t.Fatalf("an empty suburb produced -suburb: %v", got)
		}
	}
}

func TestNewCrawlSmokeRunIDIsTheOnlyShape(t *testing.T) {
	id, err := NewCrawlSmokeRunID("20261031T100000Z", "0a1b2c3d")
	if err != nil || id != "smoke-20261031T100000Z-0a1b2c3d" {
		t.Fatalf("id = %q, %v", id, err)
	}
	for _, c := range [][2]string{{"20261031T100000", "0a1b2c3d"}, {"20261031T100000Z", "0A1B2C3D"}, {"20261031T100000Z", "../../"}, {"20261031T100000Z", "0a1b2c3"}} {
		if _, err := NewCrawlSmokeRunID(c[0], c[1]); !errors.Is(err, ErrInvalidCrawlSmoke) {
			t.Errorf("%v was accepted", c)
		}
	}
}

// A malformed run id or suburb is refused before the job is resolved or any execution starts.
// The collector here has no configuration, so reaching GCP would fail differently.
func TestRunCrawlSmokeRefusesBadInputBeforeAnyCall(t *testing.T) {
	c := NewCollector(Config{})
	for _, req := range []CrawlSmokeRequest{
		{RunID: "smoke-20261031T100000Z-0a1b2c3d", Suburb: "Bondi Beach"},
		{RunID: "smoke-20261031T100000Z-0a1b2c3d", Suburb: "bondi;rm -rf"},
		{RunID: "delta-20261031T100000Z", Suburb: "bondi"},
		{RunID: "", Suburb: ""},
	} {
		if _, err := c.RunCrawlSmoke(context.Background(), req); !errors.Is(err, ErrInvalidCrawlSmoke) {
			t.Errorf("%+v: err = %v, want ErrInvalidCrawlSmoke", req, err)
		}
	}
}

func TestCrawlSmokeNamesOnlyTheCollectorJob(t *testing.T) {
	if CrawlCollectorJobName != "house-price-collector" {
		t.Fatalf("the smoke job is %q; the run.developer grant is on house-price-collector", CrawlCollectorJobName)
	}
}
