package economy

import (
	"reflect"
	"testing"
	"time"
)

func rbaRatesFixture() [][]string {
	return [][]string{
		{"F1.1 INTEREST RATES AND YIELDS"},
		{"Series ID", "FIRMMCRT"},
		{"03/06/2026", "3.60"},
		{"04/06/2026", ""},
	}
}

func rbaFXFixture() [][]string {
	return [][]string{
		{"F11.1 EXCHANGE RATES"},
		{"Series ID", "FXRUSD", "FXRTWI"},
		{"03-Jun-2026", "0.6800", "62.1"},
	}
}

func rbaCommoditiesFixture() [][]string {
	return [][]string{
		{"I2 INDEX OF COMMODITY PRICES"},
		{"Series ID", "GRCPAIAD", "GRCPRCAD", "GRCPNRAD", "GRCPBMAD", "GRCPBCAD", "GRCPBCSAD", "GRCPAIUSD"},
		{"31/05/2026", "121.8", "136.4", "112.7", "98.5", "149.2", "143.1", "999.0"},
		{"30/06/2026", "", "137.1", "113.2", "99.4", "150.3", "144.0", "999.0"},
	}
}

func rbaCreditFixture() [][]string {
	return [][]string{
		{"D1 GROWTH IN SELECTED FINANCIAL AGGREGATES"},
		{"Series ID", "DGFACH12", "DGFACOH12", "DGFACIH12", "DGFACOP12", "DGFACBNF12", "DGFACH1"},
		{"31/05/2026", "5.6", "5.1", "6.8", "1.2", "7.4", "999.0"},
		{"30/06/2026", "5.7", "5.2", "", "1.4", "7.5", "999.0"},
	}
}

func mustRBATable(t *testing.T, file string) rbaTable {
	t.Helper()
	for _, table := range rbaTables {
		if table.file == file {
			return table
		}
	}
	t.Fatalf("rbaTables missing %q", file)
	return rbaTable{}
}

func observationsByKey(obs []Obs) map[string][]Obs {
	byKey := make(map[string][]Obs)
	for _, o := range obs {
		byKey[o.Series.Key()] = append(byKey[o.Series.Key()], o)
	}
	return byKey
}

func TestRBALegacyRatesAndFXContractUnchanged(t *testing.T) {
	tests := []struct {
		file    string
		fixture [][]string
		want    map[string]SeriesDef
	}{
		{
			file:    "f1.1-data.csv",
			fixture: rbaRatesFixture(),
			want: map[string]SeriesDef{
				"rates.cash_rate_target.aus": {
					Topic: "rates", Metric: "cash_rate_target", RegionType: "national", RegionCode: "aus", RegionName: "Australia",
					Unit: "percent", Frequency: "monthly", Adjustment: "original", SourceKey: "rba-key-indicators", Licence: "CC-BY-4.0",
					Dimensions: map[string]string{"rba_series_id": "FIRMMCRT", "rba_table": "f1.1-data.csv"},
				},
			},
		},
		{
			file:    "f11.1-data.csv",
			fixture: rbaFXFixture(),
			want: map[string]SeriesDef{
				"rates.aud_usd.aus": {
					Topic: "rates", Metric: "aud_usd", RegionType: "national", RegionCode: "aus", RegionName: "Australia",
					Unit: "usd", Frequency: "daily", Adjustment: "original", SourceKey: "rba-key-indicators", Licence: "CC-BY-4.0",
					Dimensions: map[string]string{"rba_series_id": "FXRUSD", "rba_table": "f11.1-data.csv"},
				},
				"rates.trade_weighted_index.aus": {
					Topic: "rates", Metric: "trade_weighted_index", RegionType: "national", RegionCode: "aus", RegionName: "Australia",
					Unit: "index", Frequency: "daily", Adjustment: "original", SourceKey: "rba-key-indicators", Licence: "CC-BY-4.0",
					Dimensions: map[string]string{"rba_series_id": "FXRTWI", "rba_table": "f11.1-data.csv"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			table := mustRBATable(t, tt.file)
			obs, err := parseRBASeries(tt.fixture, table)
			if err != nil {
				t.Fatal(err)
			}
			byKey := observationsByKey(obs)
			if len(byKey) != len(tt.want) {
				t.Fatalf("keys=%v, want exactly %v", reflect.ValueOf(byKey).MapKeys(), reflect.ValueOf(tt.want).MapKeys())
			}
			for key, wantSeries := range tt.want {
				seriesObs, ok := byKey[key]
				if !ok || len(seriesObs) != 1 {
					t.Fatalf("%q observations=%#v, want exactly one", key, seriesObs)
				}
				if gotSeries := seriesObs[0].Series; !reflect.DeepEqual(gotSeries, wantSeries) {
					t.Errorf("legacy series contract for %q=%#v, want exactly %#v", key, gotSeries, wantSeries)
				}
			}
		})
	}
}

func TestParseRBASeriesSkipsBlankCellsAndParsesDate(t *testing.T) {
	obs, err := parseRBASeries(rbaRatesFixture(), mustRBATable(t, "f1.1-data.csv"))
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs (blank cell skipped), got %d", len(obs))
	}
	if obs[0].Value != 3.60 || !obs[0].Period.Equal(time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected observation: %#v", obs[0])
	}
}

func TestParseRBASeriesMissingPinnedSeriesFails(t *testing.T) {
	table := mustRBATable(t, "f1.1-data.csv")
	table.specs = []rbaSpec{{seriesID: "MISSING", metric: "x", unit: "y"}}
	if _, err := parseRBASeries(rbaRatesFixture(), table); err == nil {
		t.Fatal("want error for missing series")
	}
}

func TestParseRBACommodityPriceIndexes(t *testing.T) {
	obs, err := parseRBASeries(rbaCommoditiesFixture(), mustRBATable(t, "i2-data.csv"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		seriesID string
		product  string
	}{
		"commodities.price_index.all_items.aus":   {seriesID: "GRCPAIAD", product: "all_items"},
		"commodities.price_index.rural.aus":       {seriesID: "GRCPRCAD", product: "rural"},
		"commodities.price_index.non_rural.aus":   {seriesID: "GRCPNRAD", product: "non_rural"},
		"commodities.price_index.base_metals.aus": {seriesID: "GRCPBMAD", product: "base_metals"},
		"commodities.price_index.bulk.aus":        {seriesID: "GRCPBCAD", product: "bulk"},
		"commodities.price_index.bulk_spot.aus":   {seriesID: "GRCPBCSAD", product: "bulk_spot"},
	}
	byKey := observationsByKey(obs)
	if len(byKey) != len(want) {
		t.Fatalf("selected commodity keys=%v, want exactly %v", reflect.ValueOf(byKey).MapKeys(), reflect.ValueOf(want).MapKeys())
	}
	for key, expected := range want {
		seriesObs := byKey[key]
		if len(seriesObs) == 0 {
			t.Errorf("missing commodity series %q", key)
			continue
		}
		series := seriesObs[0].Series
		if series.Topic != "commodities" || series.Metric != "price_index" || series.Product != expected.product || series.Unit != "index" ||
			series.Frequency != "monthly" || series.Adjustment != "original" || series.RegionType != "national" ||
			series.RegionCode != "aus" || series.RegionName != "Australia" || series.SourceKey != "rba-commodity-prices" ||
			series.Licence != "CC-BY-4.0" {
			t.Errorf("unexpected commodity metadata for %q: %#v", key, series)
		}
		wantDimensions := map[string]string{"rba_series_id": expected.seriesID, "rba_table": "i2-data.csv"}
		if !reflect.DeepEqual(series.Dimensions, wantDimensions) {
			t.Errorf("commodity dimensions for %q=%#v, want %#v", key, series.Dimensions, wantDimensions)
		}
		for _, o := range seriesObs {
			if o.Value < 20 || o.Value > 500 {
				t.Errorf("commodity %q value %v outside magnitude guard 20..500", key, o.Value)
			}
		}
	}
	if got := len(byKey["commodities.price_index.all_items.aus"]); got != 1 {
		t.Errorf("blank all-items cell was not skipped: got %d observations, want 1", got)
	}
}

func TestParseRBACreditGrowth(t *testing.T) {
	obs, err := parseRBASeries(rbaCreditFixture(), mustRBATable(t, "d1-data.csv"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		seriesID string
		product  string
	}{
		"credit.growth_yoy.housing.aus.seasadj":                {seriesID: "DGFACH12", product: "housing"},
		"credit.growth_yoy.owner_occupier_housing.aus.seasadj": {seriesID: "DGFACOH12", product: "owner_occupier_housing"},
		"credit.growth_yoy.investor_housing.aus.seasadj":       {seriesID: "DGFACIH12", product: "investor_housing"},
		"credit.growth_yoy.personal.aus.seasadj":               {seriesID: "DGFACOP12", product: "personal"},
		"credit.growth_yoy.business.aus.seasadj":               {seriesID: "DGFACBNF12", product: "business"},
	}
	byKey := observationsByKey(obs)
	if len(byKey) != len(want) {
		t.Fatalf("selected credit keys=%v, want exactly %v", reflect.ValueOf(byKey).MapKeys(), reflect.ValueOf(want).MapKeys())
	}
	for key, expected := range want {
		seriesObs := byKey[key]
		if len(seriesObs) == 0 {
			t.Errorf("missing credit series %q", key)
			continue
		}
		series := seriesObs[0].Series
		if series.Topic != "credit" || series.Metric != "growth_yoy" || series.Product != expected.product || series.Unit != "percent" ||
			series.Frequency != "monthly" || series.Adjustment != "seasadj" || series.RegionType != "national" ||
			series.RegionCode != "aus" || series.RegionName != "Australia" || series.SourceKey != "rba-credit-aggregates" ||
			series.Licence != "CC-BY-4.0" {
			t.Errorf("unexpected credit metadata for %q: %#v", key, series)
		}
		wantDimensions := map[string]string{"rba_series_id": expected.seriesID, "rba_table": "d1-data.csv"}
		if !reflect.DeepEqual(series.Dimensions, wantDimensions) {
			t.Errorf("credit dimensions for %q=%#v, want %#v", key, series.Dimensions, wantDimensions)
		}
		for _, o := range seriesObs {
			if o.Value < -10 || o.Value > 30 {
				t.Errorf("credit %q value %v outside magnitude guard -10..30", key, o.Value)
			}
		}
	}
	if got := len(byKey["credit.growth_yoy.investor_housing.aus.seasadj"]); got != 1 {
		t.Errorf("blank investor-housing cell was not skipped: got %d observations, want 1", got)
	}
}

func TestRBANewSourcesAreRegistered(t *testing.T) {
	want := map[string]sourceDef{
		"rba-commodity-prices": {
			Key: "rba-commodity-prices", DisplayName: "RBA Index of Commodity Prices", SignalKind: "economic_series",
			Publisher: "Reserve Bank of Australia", URL: "https://www.rba.gov.au/statistics/tables/",
			Licence: "CC-BY-4.0", Cadence: "Monthly", Method: "download", Notes: "Table I2",
		},
		"rba-credit-aggregates": {
			Key: "rba-credit-aggregates", DisplayName: "RBA Growth in Selected Financial Aggregates", SignalKind: "economic_series",
			Publisher: "Reserve Bank of Australia", URL: "https://www.rba.gov.au/statistics/tables/",
			Licence: "CC-BY-4.0", Cadence: "Monthly", Method: "download", Notes: "Table D1",
		},
	}
	for _, source := range sourceDefs {
		expected, ok := want[source.Key]
		if !ok {
			continue
		}
		if source.Key != expected.Key || source.DisplayName != expected.DisplayName || source.SignalKind != expected.SignalKind ||
			source.Publisher != expected.Publisher || source.URL != expected.URL || source.Licence != expected.Licence ||
			source.Cadence != expected.Cadence || source.Method != expected.Method || source.Notes != expected.Notes {
			t.Errorf("source %q=%#v, want %#v", source.Key, source, expected)
		}
		delete(want, source.Key)
	}
	for key := range want {
		t.Errorf("sourceDefs missing %q", key)
	}
}
