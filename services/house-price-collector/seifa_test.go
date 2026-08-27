package main

import (
	"context"
	"reflect"
	"testing"
)

func TestSEIFAColumnsForPinnedIndexCodes(t *testing.T) {
	tests := []struct {
		index       string
		score       string
		decileAus   string
		decileState string
	}{
		{"IRSD", "seifa_irsd_score", "seifa_irsd_decile_aus", "seifa_irsd_decile_state"},
		{"IRSAD", "seifa_irsad_score", "seifa_irsad_decile_aus", "seifa_irsad_decile_state"},
		{"IER", "seifa_ier_score", "seifa_ier_decile_aus", "seifa_ier_decile_state"},
		{"IEO", "seifa_ieo_score", "seifa_ieo_decile_aus", "seifa_ieo_decile_state"},
	}

	for _, tt := range tests {
		t.Run(tt.index, func(t *testing.T) {
			got, ok := seifaColumnsFor(tt.index)
			if !ok {
				t.Fatalf("seifaColumnsFor(%q) was not recognised", tt.index)
			}
			if got.score != tt.score || got.decileAus != tt.decileAus || got.decileState != tt.decileState {
				t.Fatalf("seifaColumnsFor(%q) = %+v, want score=%q decileAus=%q decileState=%q",
					tt.index, got, tt.score, tt.decileAus, tt.decileState)
			}
		})
	}

	if _, ok := seifaColumnsFor("UNKNOWN"); ok {
		t.Fatal("unknown SEIFAINDEXTYPE must not map to database columns")
	}
}

func TestSEIFAFetchKeysPageByIndexAndIncludeQualityMeasure(t *testing.T) {
	want := map[string]string{
		"IRSD":  ".IRSD.SCORE+RWAD+RWSD+URPXSA1",
		"IRSAD": ".IRSAD.SCORE+RWAD+RWSD+URPXSA1",
		"IER":   ".IER.SCORE+RWAD+RWSD+URPXSA1",
		"IEO":   ".IEO.SCORE+RWAD+RWSD+URPXSA1",
	}
	for index, key := range want {
		if got := seifaFetchKey(index); got != key {
			t.Errorf("seifaFetchKey(%q) = %q, want %q", index, got, key)
		}
	}
}

func TestFetchSEIFAPagesOncePerPinnedIndex(t *testing.T) {
	type call struct {
		dataflow    string
		key         string
		startPeriod string
	}
	var calls []call
	fetch := func(_ context.Context, dataflow, key, startPeriod string) ([][]string, error) {
		calls = append(calls, call{dataflow: dataflow, key: key, startPeriod: startPeriod})
		return [][]string{{"SAL", "SEIFAINDEXTYPE", "SEIFA_MEASURE", "OBS_VALUE"}}, nil
	}

	values, fetched, err := fetchSEIFA(context.Background(), fetch)
	if err != nil {
		t.Fatalf("fetchSEIFA returned error: %v", err)
	}
	if len(values) != 0 || fetched != 0 {
		t.Fatalf("empty response produced %d values and %d fetched rows", len(values), fetched)
	}
	want := []call{
		{seifaDataflow, ".IRSD.SCORE+RWAD+RWSD+URPXSA1", "2021"},
		{seifaDataflow, ".IRSAD.SCORE+RWAD+RWSD+URPXSA1", "2021"},
		{seifaDataflow, ".IER.SCORE+RWAD+RWSD+URPXSA1", "2021"},
		{seifaDataflow, ".IEO.SCORE+RWAD+RWSD+URPXSA1", "2021"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("fetch calls = %#v, want %#v", calls, want)
	}
}

func TestParseSEIFARowsMapsLabelledCodesAndIgnoresUnknownCodes(t *testing.T) {
	rows := [][]string{
		{"SAL: Suburb", "SEIFAINDEXTYPE: Index", "SEIFA_MEASURE: Measure", "TIME_PERIOD: Time", "OBS_VALUE: Value"},
		{"10707: Burren Junction", "IRSD: Disadvantage", "SCORE: Score", "2021", "912"},
		{"10707: Burren Junction", "IRSD: Disadvantage", "RWAD: Decile within Australia", "2021", "3"},
		{"10707: Burren Junction", "IRSD: Disadvantage", "RWSD: Decile within state", "2021", "2"},
		{"10707: Burren Junction", "IRSD: Disadvantage", "URPXSA1: Population without score", "2021", "7.5"},
		{"10707: Burren Junction", "IRSD: Disadvantage", "NOT_A_MEASURE: Unknown", "2021", "99"},
		{"10707: Burren Junction", "NOT_AN_INDEX: Unknown", "SCORE: Score", "2021", "1200"},
	}

	got := parseSEIFARows(rows, "IRSD")
	if len(got) != 1 {
		t.Fatalf("parseSEIFARows returned %d rows, want 1: %+v", len(got), got)
	}
	r := got[0]
	if r.salCode != "10707" || r.indexType != "IRSD" {
		t.Fatalf("parsed identity = %q/%q, want 10707/IRSD", r.salCode, r.indexType)
	}
	assertSEIFAInt(t, "score", r.score, 912)
	assertSEIFAInt(t, "Australia decile", r.decileAus, 3)
	assertSEIFAInt(t, "state decile", r.decileState, 2)
	if r.missingSA1Share == nil || *r.missingSA1Share != 7.5 {
		t.Fatalf("missing-SA1 share = %v, want 7.5", r.missingSA1Share)
	}
	if r.qualityGated {
		t.Fatal("7.5% missing SA1 share must remain below the quality gate")
	}
}

func TestParseSEIFARowsSkipsBlankAndNonNumericObservationValues(t *testing.T) {
	rows := [][]string{
		{"SAL", "SEIFAINDEXTYPE", "SEIFA_MEASURE", "OBS_VALUE"},
		{"20001", "IRSAD", "SCORE", ""},
		{"20001", "IRSAD", "RWAD", "not available"},
		{"20001", "IRSAD", "RWSD", ".."},
	}

	if got := parseSEIFARows(rows, "IRSAD"); len(got) != 0 {
		t.Fatalf("blank/non-numeric observations must be skipped, got %+v", got)
	}
}

func TestParseSEIFARowsClearsValuesAboveMissingSA1QualityGate(t *testing.T) {
	if seifaMissingSA1ShareThreshold != 10 {
		t.Fatalf("quality threshold = %v, want the stated 10%% policy", seifaMissingSA1ShareThreshold)
	}
	rows := [][]string{
		{"SAL", "SEIFAINDEXTYPE", "SEIFA_MEASURE", "OBS_VALUE"},
		{"30001", "IEO", "SCORE", "1050"},
		{"30001", "IEO", "RWAD", "8"},
		{"30001", "IEO", "RWSD", "9"},
		{"30001", "IEO", "URPXSA1", "10.1"},
	}

	got := parseSEIFARows(rows, "IEO")
	if len(got) != 1 {
		t.Fatalf("parseSEIFARows returned %d rows, want one gated row", len(got))
	}
	if !got[0].qualityGated {
		t.Fatal("share above threshold must quality-gate the suburb")
	}
	if got[0].score != nil || got[0].decileAus != nil || got[0].decileState != nil {
		t.Fatalf("quality-gated values must be cleared, got %+v", got[0])
	}
}

func assertSEIFAInt(t *testing.T, name string, got *int, want int) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("%s = %v, want %d", name, got, want)
	}
}
