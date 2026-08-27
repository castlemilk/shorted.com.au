package shorts

import (
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestSuburbMetricRegistryCoversMapAndLandedColumns(t *testing.T) {
	existing := []string{
		"price", "population", "age", "income", "born_overseas", "religion", "language",
		"federal_party", "federal_lean", "state_party", "politician_property",
		"crime_break_ins", "crime_violent", "crime_motor_vehicle", "amenity_density",
		"supermarkets", "pubs", "grocery", "healthcare", "school_sector",
		"nearest_train", "distance_to_coast", "nbn",
	}
	landed := []string{
		"seifa_irsd_score", "seifa_irsd_decile_aus", "seifa_irsd_decile_state",
		"seifa_irsad_score", "seifa_irsad_decile_aus", "seifa_irsad_decile_state",
		"seifa_ier_score", "seifa_ier_decile_aus", "seifa_ier_decile_state",
		"seifa_ieo_score", "seifa_ieo_decile_aus", "seifa_ieo_decile_state",
		"pct_low_personal_income", "pct_high_personal_income", "unemployment_rate",
		"labour_force_participation_rate", "pct_bachelor_or_higher", "pct_separate_house",
		"pct_flat_apartment", "pct_couple_with_children", "pct_lone_person_household",
		"elevation_min_m", "elevation_median_m", "elevation_max_m",
		"land_share_below_1m", "land_share_below_2m", "land_share_below_5m",
	}
	want := append(append([]string{}, existing...), landed...)
	sort.Strings(want)

	got := SupportedSuburbMetricKeys()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("supported keys\n got: %v\nwant: %v", got, want)
	}

	// Guard the cross-language vocabulary at its source. This deliberately reads
	// only the MetricKey declaration, not arbitrary string literals in the file.
	source, err := os.ReadFile("../../../../../web/src/@/lib/housing/highlight-metrics.ts")
	if err != nil {
		t.Fatalf("read highlight metric registry: %v", err)
	}
	declaration := regexp.MustCompile(`(?s)export type MetricKey =(?P<body>.*?);`).FindSubmatch(source)
	if declaration == nil {
		t.Fatal("MetricKey declaration not found")
	}
	matches := regexp.MustCompile(`"([a-z0-9_]+)"`).FindAllSubmatch(declaration[1], -1)
	uiKeys := make([]string, 0, len(matches))
	for _, match := range matches {
		uiKeys = append(uiKeys, string(match[1]))
	}
	sort.Strings(uiKeys)
	sort.Strings(existing)
	if !reflect.DeepEqual(uiKeys, existing) {
		t.Fatalf("Go/UI existing metric vocabulary drift\n  UI: %v\n  Go: %v", uiKeys, existing)
	}
}

func TestSuburbMetricRegistryMapsKnownKeysToExpectedColumns(t *testing.T) {
	tests := map[string]string{
		"population":                      "d.population",
		"price":                           "r.value",
		"supermarkets":                    "a.supermarkets_total",
		"crime_break_ins":                 "cr.break_ins_rank",
		"nbn":                             "c.dominant_nbn_tech",
		"seifa_irsd_score":                "d.seifa_irsd_score",
		"pct_bachelor_or_higher":          "d.pct_bachelor_or_higher",
		"land_share_below_2m":             "d.land_share_below_2m",
		"politician_property":             "rp.declared_property_count",
		"labour_force_participation_rate": "d.labour_force_participation_rate",
	}
	for key, column := range tests {
		def, ok := lookupSuburbMetric(key)
		if !ok {
			t.Errorf("known key %q was rejected", key)
			continue
		}
		if !strings.Contains(def.expression, column) {
			t.Errorf("%s expression %q does not read %q", key, def.expression, column)
		}
	}
	if _, ok := lookupSuburbMetric("population; DROP TABLE suburb_demographics"); ok {
		t.Fatal("caller-controlled SQL was accepted as a metric key")
	}
}

func TestBuildSuburbMetricQuerySelectsOnlyRequestedColumnsInSALOrder(t *testing.T) {
	query, definitions, err := buildSuburbMetricQuery([]string{"population", "price"})
	if err != nil {
		t.Fatalf("build query: %v", err)
	}
	if len(definitions) != 2 || definitions[0].key != "population" || definitions[1].key != "price" {
		t.Fatalf("definitions did not preserve request order: %+v", definitions)
	}
	for _, want := range []string{"SELECT d.sal_code", "d.population", "r.value", "WHERE d.state_code = $1", "ORDER BY d.sal_code"} {
		if !strings.Contains(query, want) {
			t.Errorf("query missing %q:\n%s", want, query)
		}
	}
	for _, unwanted := range []string{"SELECT *", "d.seifa_irsd_score", "d.elevation_min_m", "suburb_amenities a"} {
		if strings.Contains(query, unwanted) {
			t.Errorf("query selected/joined unrequested data %q:\n%s", unwanted, query)
		}
	}
}

func TestSuburbIndexVersionDependsOnlyOnSALCodeSet(t *testing.T) {
	a := suburbIndexVersion([]string{"102", "101", "103"})
	b := suburbIndexVersion([]string{"103", "102", "101"})
	if a != b {
		t.Fatalf("same sal_code set produced unstable versions: %q != %q", a, b)
	}
	if a == suburbIndexVersion([]string{"101", "102", "104"}) {
		t.Fatal("changed sal_code set did not change index version")
	}
	if !strings.HasPrefix(a, "v1-") || len(a) != len("v1-")+12 {
		t.Fatalf("version %q is not the documented short v1 hash", a)
	}
}

func TestAppendMetricValuePreservesNullVersusGenuineZero(t *testing.T) {
	column := &SuburbMetricColumnRow{Key: "land_share_below_2m"}
	appendMetricValue(column, 0, true)
	appendMetricValue(column, 0, false)

	if !reflect.DeepEqual(column.Values, []float32{0, 0}) {
		t.Fatalf("values = %v, want two zero placeholders", column.Values)
	}
	if bitIsSet(column.NullMask, 0) {
		t.Fatal("valid zero was marked NULL")
	}
	if !bitIsSet(column.NullMask, 1) {
		t.Fatal("absent value was not marked NULL")
	}
}

func TestFinalizeMetricNullMasksSizesAllPresentMask(t *testing.T) {
	column := &SuburbMetricColumnRow{Key: "population", Values: make([]float32, 9)}
	finalizeMetricNullMasks([]*SuburbMetricColumnRow{column})
	if !reflect.DeepEqual(column.NullMask, []byte{0, 0}) {
		t.Fatalf("all-present null mask = %08b, want two explicit zero bytes", column.NullMask)
	}
}

func TestValidateSuburbMetricPredicatesRejectsInvalidRanges(t *testing.T) {
	one, zero := float32(1), float32(0)
	for _, predicates := range [][]SuburbMetricPredicateRow{
		{{MetricKey: "population"}},
		{{MetricKey: "population", Min: &one, Max: &zero}},
		{{MetricKey: "not_a_metric", Min: &zero}},
	} {
		if err := ValidateSuburbMetricPredicates(predicates); err == nil {
			t.Fatalf("invalid predicates accepted: %+v", predicates)
		}
	}
}

func TestSuburbIndexQueryUsesStableSALOrdering(t *testing.T) {
	for _, want := range []string{
		"SELECT sal_code, sal_name, COALESCE(postcode, '')",
		"WHERE state_code = $1",
		"ORDER BY sal_code",
	} {
		if !strings.Contains(suburbIndexQuery, want) {
			t.Errorf("suburb index query missing %q: %s", want, suburbIndexQuery)
		}
	}
}

func TestFilterSuburbMetricColumnsANDsPredicatesAndExcludesNulls(t *testing.T) {
	columns := []*SuburbMetricColumnRow{
		{Key: "income", Values: []float32{800, 1200, 1600, 2000}},
		{Key: "land_share_below_2m", Values: []float32{0, 1, 0, 4}, NullMask: []byte{0b00000100}},
	}
	minIncome, maxIncome := float32(1000), float32(1800)
	maxLowLand := float32(1)
	mask, count, err := filterSuburbMetricColumns(columns, []SuburbMetricPredicateRow{
		{MetricKey: "income", Min: &minIncome, Max: &maxIncome},
		{MetricKey: "land_share_below_2m", Max: &maxLowLand},
	})
	if err != nil {
		t.Fatalf("filter: %v", err)
	}
	// LSB-first: row 1 is the only match, so byte 0 is 00000010.
	if !reflect.DeepEqual(mask, []byte{0b00000010}) {
		t.Fatalf("mask = %08b, want row 1 only", mask)
	}
	if count != 1 {
		t.Fatalf("match_count = %d, want 1", count)
	}
}

func TestFilterSuburbMetricColumnsMatchCountEqualsPopulationCount(t *testing.T) {
	column := &SuburbMetricColumnRow{Key: "population", Values: []float32{1, 2, 3, 4, 5, 6, 7, 8, 9}}
	min := float32(3)
	mask, count, err := filterSuburbMetricColumns([]*SuburbMetricColumnRow{column}, []SuburbMetricPredicateRow{{MetricKey: "population", Min: &min}})
	if err != nil {
		t.Fatalf("filter: %v", err)
	}
	var population uint32
	for i := range column.Values {
		if bitIsSet(mask, i) {
			population++
		}
	}
	if count != population || count != 7 {
		t.Fatalf("match_count=%d population=%d, want 7", count, population)
	}
}
