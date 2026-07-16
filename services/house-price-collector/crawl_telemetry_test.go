package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTelemetryWriter_EmitsNDJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemetry.ndjson")
	tw := newTelemetryWriter(telemetryConfig{enabled: true, path: path, runID: "testrun"})
	if tw.f == nil {
		t.Fatal("expected an enabled writer")
	}

	beds := int16(3)
	tw.suburbStart("Newtown", "rea")
	tw.listing("Newtown", "rea", RawListing{
		ListingID: "123", ListingURL: "https://x/123", DisplayAddr: "1 Smith St",
		PriceDisplay: "$950,000", PriceKind: "fixed", Status: "for_sale", Bedrooms: &beds,
		AgencyName: "Ray White", AgentNames: []string{"Jane Doe"},
	})
	tw.suburbDone("Newtown", "rea", 1, 1, "complete")
	tw.Close()

	// Read back the NDJSON — every line must be a valid object carrying ts/type/run_id.
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	types := map[string]map[string]any{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var ev map[string]any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("invalid NDJSON line %q: %v", sc.Text(), err)
		}
		if ev["ts"] == nil || ev["run_id"] != "testrun" {
			t.Fatalf("event missing ts/run_id: %v", ev)
		}
		types[ev["type"].(string)] = ev
	}
	for _, want := range []string{"run_start", "suburb_start", "listing", "suburb_done", "run_done"} {
		if _, ok := types[want]; !ok {
			t.Fatalf("missing %q event; got %v", want, keysOf(types))
		}
	}
	// The listing event must carry the extracted fields (agency/agents/url/price).
	l := types["listing"]
	if l["agency"] != "Ray White" || l["url"] != "https://x/123" || l["price"] != "$950,000" {
		t.Fatalf("listing event missing extracted fields: %v", l)
	}
	if agents, ok := l["agents"].([]any); !ok || len(agents) != 1 || agents[0] != "Jane Doe" {
		t.Fatalf("listing event missing agents: %v", l["agents"])
	}
}

func TestTelemetryWriter_DisabledIsNoOp(t *testing.T) {
	tw := newTelemetryWriter(telemetryConfig{enabled: false})
	// All calls must be safe no-ops on a disabled writer (and on a nil one).
	tw.suburbStart("X", "rea")
	tw.listing("X", "rea", RawListing{ListingID: "1"})
	tw.suburbDone("X", "rea", 0, 0, "complete")
	tw.failure("X", "rea", "blocked", nil)
	tw.Close()
	var nilTW *telemetryWriter
	nilTW.suburbStart("X", "rea") // must not panic
}

func keysOf(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
