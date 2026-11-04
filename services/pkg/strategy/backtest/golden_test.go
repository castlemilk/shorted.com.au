package backtest

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// updateGolden rewrites the committed golden files from the generator and the
// run. Use it only after an engine or recipe change:
//
//	GOWORK=off go test ./pkg/strategy/backtest -run Golden -args -update
var updateGolden = flag.Bool("update", false, "rewrite the golden dataset and its expected output")

const goldenDir = "testdata/golden"

// goldenExpected is the committed output of the golden run.
type goldenExpected struct {
	OutputHash  string  `json:"output_hash"`
	Sessions    int     `json:"sessions"`
	TotalReturn float64 `json:"total_return"`
	CAGR        float64 `json:"cagr"`
	MaxDrawdown float64 `json:"max_drawdown"`
	Trades      []Trade `json:"trades"`
}

// goldenFiles renders the generated market as the CSV files on disk.
func goldenFiles(g goldenData) map[string][]byte {
	out := map[string][]byte{}
	write := func(name string, header []string, rows [][]string) {
		var b bytes.Buffer
		w := csv.NewWriter(&b)
		_ = w.Write(header)
		_ = w.WriteAll(rows)
		w.Flush()
		out[name] = b.Bytes()
	}
	f := func(x float64) string { return strconv.FormatFloat(x, 'g', -1, 64) }

	var bars [][]string
	for _, code := range sortedGoldenCodes(g.bars) {
		for _, b := range g.bars[code] {
			bars = append(bars, []string{code, b.Date.String(), f(b.Open), f(b.High), f(b.Low), f(b.Close), f(b.AdjClose), f(b.Volume)})
		}
	}
	write("bars.csv", []string{"code", "date", "open", "high", "low", "close", "adj_close", "volume"}, bars)

	var idx [][]string
	for _, row := range []struct {
		name string
		bars []features.IndexBar
	}{{"XJO", g.mkt.XJO}, {"XJT", g.mkt.XJT}} {
		for _, b := range row.bars {
			idx = append(idx, []string{row.name, b.Date.String(), f(b.High), f(b.Low), f(b.Close)})
		}
	}
	write("index.csv", []string{"index", "date", "high", "low", "close"}, idx)

	var asic [][]string
	for _, r := range g.mkt.ASIC {
		asic = append(asic, []string{r.Code, r.ReportDate.String(), r.Product, f(r.Positions), f(r.Issued), f(*r.Percent)})
	}
	write("asic.csv", []string{"code", "report_date", "product", "positions", "issued", "percent"}, asic)

	var ing [][]string
	for _, r := range g.mkt.Ingests {
		ing = append(ing, []string{r.ReportDate.String(), strconv.Itoa(*r.FileRows), strconv.Itoa(r.LoadedRows)})
	}
	write("ingests.csv", []string{"report_date", "file_rows", "loaded_rows"}, ing)

	var divs [][]string
	for _, code := range sortedGoldenCodes(g.bars) {
		for _, d := range g.divs[code] {
			divs = append(divs, []string{code, d.ExDate.String(), f(d.AmountPerShare)})
		}
	}
	write("dividends.csv", []string{"code", "ex_date", "amount_per_share"}, divs)

	var rates [][]string
	for _, r := range g.mkt.CashRate {
		rates = append(rates, []string{r.Date.String(), f(r.Rate)})
	}
	write("rates.csv", []string{"date", "rate"}, rates)

	var names [][]string
	for _, code := range sortedGoldenCodes(g.bars) {
		names = append(names, []string{code, g.names[code]})
	}
	write("names.csv", []string{"code", "name"}, names)
	return out
}

// readGoldenCSV reads a file's rows, without its header.
func readGoldenCSV(t *testing.T, name string) [][]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(goldenDir, name))
	if err != nil {
		t.Fatalf("golden file %s: %v (regenerate with -args -update)", name, err)
	}
	rows, err := csv.NewReader(bytes.NewReader(b)).ReadAll()
	if err != nil {
		t.Fatalf("golden file %s: %v", name, err)
	}
	return rows[1:]
}

// mustFloat parses a golden CSV number, failing the test on a bad field.
func mustFloat(t *testing.T, s string) float64 {
	t.Helper()
	x, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("golden number %q: %v", s, err)
	}
	return x
}

// mustDate parses a golden CSV date.
func mustDate(t *testing.T, s string) civil.Date {
	t.Helper()
	d, err := civil.ParseDate(s)
	if err != nil {
		t.Fatalf("golden date %q: %v", s, err)
	}
	return d
}

// loadGolden reads the committed dataset into the inputs a run reads.
func loadGolden(t *testing.T) *MemoryInputs {
	t.Helper()
	m := &MemoryInputs{BarsByCode: map[string][]features.Bar{}, Divs: map[string][]features.Dividend{}, Funds: map[string]features.Fundamentals{}}
	m.Mkt.ETPs = map[string]bool{}
	m.Mkt.Names = map[string]string{}
	for _, r := range readGoldenCSV(t, "bars.csv") {
		m.BarsByCode[r[0]] = append(m.BarsByCode[r[0]], features.Bar{
			Date: mustDate(t, r[1]), Open: mustFloat(t, r[2]), High: mustFloat(t, r[3]), Low: mustFloat(t, r[4]),
			Close: mustFloat(t, r[5]), AdjClose: mustFloat(t, r[6]), Volume: mustFloat(t, r[7]),
		})
	}
	for _, r := range readGoldenCSV(t, "index.csv") {
		b := features.IndexBar{Date: mustDate(t, r[1]), High: mustFloat(t, r[2]), Low: mustFloat(t, r[3]), Close: mustFloat(t, r[4])}
		if r[0] == "XJO" {
			m.Mkt.XJO = append(m.Mkt.XJO, b)
		} else {
			m.Mkt.XJT = append(m.Mkt.XJT, b)
		}
	}
	for _, r := range readGoldenCSV(t, "asic.csv") {
		pct := mustFloat(t, r[5])
		m.Mkt.ASIC = append(m.Mkt.ASIC, features.ASICRow{
			Code: r[0], ReportDate: mustDate(t, r[1]), Product: r[2],
			Positions: mustFloat(t, r[3]), Issued: mustFloat(t, r[4]), Percent: &pct,
		})
	}
	for _, r := range readGoldenCSV(t, "ingests.csv") {
		fr, err := strconv.Atoi(r[1])
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := strconv.Atoi(r[2])
		if err != nil {
			t.Fatal(err)
		}
		m.Mkt.Ingests = append(m.Mkt.Ingests, features.ReportIngest{ReportDate: mustDate(t, r[0]), FileRows: &fr, LoadedRows: loaded})
	}
	for _, r := range readGoldenCSV(t, "dividends.csv") {
		m.Divs[r[0]] = append(m.Divs[r[0]], features.Dividend{ExDate: mustDate(t, r[1]), AmountPerShare: mustFloat(t, r[2])})
	}
	for _, r := range readGoldenCSV(t, "rates.csv") {
		m.Mkt.CashRate = append(m.Mkt.CashRate, features.RatePoint{Date: mustDate(t, r[0]), Rate: mustFloat(t, r[1])})
	}
	for _, r := range readGoldenCSV(t, "names.csv") {
		m.Mkt.Names[r[0]] = r[1]
	}
	return m
}

// writeGolden regenerates the committed files.
func writeGolden(t *testing.T, files map[string][]byte) {
	t.Helper()
	if err := os.MkdirAll(goldenDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(goldenDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestGoldenDataIsReproducible holds the committed CSV to the generator, so the
// dataset can be rebuilt from its seed and a change to it is a deliberate one.
func TestGoldenDataIsReproducible(t *testing.T) {
	files := goldenFiles(buildGolden())
	if *updateGolden {
		writeGolden(t, files)
	}
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(goldenDir, name))
		if err != nil {
			t.Fatalf("%s: %v (regenerate with -args -update)", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s differs from the generator; regenerate with -args -update", name)
		}
	}
}

// TestGoldenRun is the golden form of the run: the committed dataset, the
// crowded-short version and its recipe, against the committed output hash,
// metrics and trades.
func TestGoldenRun(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	r := goldenRecipe(t)
	res, err := Run(in, s, r)
	if err != nil {
		t.Fatal(err)
	}
	got := goldenExpected{
		OutputHash:  res.OutputHash,
		Sessions:    len(res.Sessions),
		TotalReturn: res.Metrics.TotalReturn,
		CAGR:        res.Metrics.CAGR,
		MaxDrawdown: res.Metrics.MaxDrawdown.Depth,
		Trades:      res.Trades,
	}
	path := filepath.Join(goldenDir, "expected.json")
	if *updateGolden {
		b, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected.json: %v (regenerate with -args -update)", err)
	}
	var want goldenExpected
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	if got.OutputHash != want.OutputHash {
		t.Fatalf("output hash %s, want %s", got.OutputHash, want.OutputHash)
	}
	if got.Sessions != want.Sessions || got.TotalReturn != want.TotalReturn || got.CAGR != want.CAGR || got.MaxDrawdown != want.MaxDrawdown {
		t.Fatalf("metrics %+v, want %+v", got, want)
	}
	if len(got.Trades) != len(want.Trades) {
		t.Fatalf("%d trades, want %d", len(got.Trades), len(want.Trades))
	}
	for i := range got.Trades {
		if fmt.Sprint(got.Trades[i]) != fmt.Sprint(want.Trades[i]) {
			t.Fatalf("trade %d: %+v, want %+v", i, got.Trades[i], want.Trades[i])
		}
	}
	if len(got.Trades) == 0 {
		t.Fatal("the golden run must trade, or the gates test nothing")
	}
}
