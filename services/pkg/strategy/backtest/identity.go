package backtest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// digestBytes is the prefix of a code's digest that is stored: 16 bytes, shown
// as 32 hex characters.
const digestBytes = 16

// outputRound is the quantum a published output is rounded to before it is hashed.
const outputRound = 1e6

// Digest is one code's sub-digest of its price rows up to a cut-off: the
// row count and a truncated SHA-256 of the rows.
type Digest struct {
	Rows int    `json:"rows"`
	Sum  string `json:"sum"`
}

// CutOff is the cut-off of a run's per-code digests: the last day of the last
// month that closed before prices_through. Rows dated after it may still change
// with ordinary daily appends, so they do not enter a digest.
func CutOff(pricesThrough civil.Date) civil.Date {
	first := civil.Date{Year: pricesThrough.Year, Month: pricesThrough.Month, Day: 1}
	return first.AddDays(-1)
}

// InSampleUntil is the last day of the in-sample period: the day before the
// rules froze (live_from).
func InSampleUntil(liveFrom civil.Date) civil.Date { return liveFrom.AddDays(-1) }

// fmtFloat is the canonical text of a float: the shortest form that round-trips.
func fmtFloat(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }

// fmtOptFloat is fmtFloat, with a nil value written as "-", the SQL NULL.
func fmtOptFloat(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmtFloat(*v)
}

// barLine is a bar's canonical row: code|date|open|high|low|close|adj|volume.
func barLine(code string, b features.Bar) string {
	return fmt.Sprintf("bar|%s|%s|%s|%s|%s|%s|%s|%s\n", code, b.Date,
		fmtFloat(b.Open), fmtFloat(b.High), fmtFloat(b.Low), fmtFloat(b.Close), fmtFloat(b.AdjClose), fmtFloat(b.Volume))
}

// divLine is a dividend row: code|ex-date|amount per share.
func divLine(code string, d features.Dividend) string {
	return fmt.Sprintf("div|%s|%s|%s\n", code, d.ExDate, fmtFloat(d.AmountPerShare))
}

// InputHash is SHA-256 over every row a run reads, in a canonical order:
// bars, dividends and fundamentals per code; the index bars, the ASIC rows, the
// report ingests, the ETP set, the company names, the industry groups and the cash
// rate series. The calendar is derived from the index and ASIC dates, so it is
// covered by them. Floats are written in their shortest round-trip form.
func InputHash(in Inputs) (string, error) {
	h := sha256.New()
	codes := append([]string(nil), in.Codes()...)
	sort.Strings(codes)
	for _, code := range codes {
		for _, b := range in.Bars(code) {
			writeTo(h, barLine(code, b))
		}
		ds := append([]features.Dividend(nil), in.Dividends(code)...)
		sort.SliceStable(ds, func(i, j int) bool { return ds[i].ExDate.Before(ds[j].ExDate) })
		for _, d := range ds {
			writeTo(h, divLine(code, d))
		}
		f := in.Fundamentals(code)
		writeTo(h, fmt.Sprintf("fund|%s|%s|%d|", code, f.Hash, len(f.Blob)))
		h.Write(f.Blob)
		h.Write([]byte("\n"))
	}
	m := in.Market()
	writeIndex(h, "xjo", m.XJO)
	writeIndex(h, "xjt", m.XJT)
	asic := append([]features.ASICRow(nil), m.ASIC...)
	sort.SliceStable(asic, func(i, j int) bool {
		if asic[i].ReportDate != asic[j].ReportDate {
			return asic[i].ReportDate.Before(asic[j].ReportDate)
		}
		return asic[i].Code < asic[j].Code
	})
	for _, r := range asic {
		writeTo(h, fmt.Sprintf("asic|%s|%s|%s|%s|%s|%s\n", r.ReportDate, r.Code, r.Product,
			fmtFloat(r.Positions), fmtFloat(r.Issued), fmtOptFloat(r.Percent)))
	}
	ingests := append([]features.ReportIngest(nil), m.Ingests...)
	sort.SliceStable(ingests, func(i, j int) bool { return ingests[i].ReportDate.Before(ingests[j].ReportDate) })
	for _, g := range ingests {
		file := "-"
		if g.FileRows != nil {
			file = strconv.Itoa(*g.FileRows)
		}
		writeTo(h, fmt.Sprintf("ingest|%s|%s|%d\n", g.ReportDate, file, g.LoadedRows))
	}
	for _, code := range sortedKeys(m.ETPs) {
		writeTo(h, fmt.Sprintf("etp|%s|%t\n", code, m.ETPs[code]))
	}
	for _, code := range sortedKeys(m.Names) {
		writeTo(h, fmt.Sprintf("name|%s|%s\n", code, m.Names[code]))
	}
	for _, code := range sortedKeys(m.Industry) {
		writeTo(h, fmt.Sprintf("industry|%s|%s\n", code, m.Industry[code]))
	}
	rates := append([]features.RatePoint(nil), m.CashRate...)
	sort.SliceStable(rates, func(i, j int) bool { return rates[i].Date.Before(rates[j].Date) })
	for _, p := range rates {
		writeTo(h, fmt.Sprintf("rate|%s|%s\n", p.Date, fmtFloat(p.Rate)))
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// writeTo streams text into a hash.
func writeTo(h interface{ Write([]byte) (int, error) }, text string) {
	_, _ = h.Write([]byte(text))
}

// writeIndex writes an index's bars in date order.
func writeIndex(h interface{ Write([]byte) (int, error) }, name string, bars []features.IndexBar) {
	bs := append([]features.IndexBar(nil), bars...)
	sort.SliceStable(bs, func(i, j int) bool { return bs[i].Date.Before(bs[j].Date) })
	for _, b := range bs {
		writeTo(h, fmt.Sprintf("%s|%s|%s|%s|%s\n", name, b.Date, fmtFloat(b.High), fmtFloat(b.Low), fmtFloat(b.Close)))
	}
}

// CodeDigests is each code's sub-digest over its bars and dividends dated on or
// before cutoff. Codes with no such row have no digest. Fundamentals, names
// and ASIC rows are not in a digest: the first is undated, and the diff note lists
// ASIC changes from the revisions table, not from digests.
func CodeDigests(in Inputs, cutoff civil.Date) map[string]Digest {
	out := map[string]Digest{}
	codes := append([]string(nil), in.Codes()...)
	sort.Strings(codes)
	for _, code := range codes {
		h := sha256.New()
		rows := 0
		for _, b := range in.Bars(code) {
			if b.Date.After(cutoff) {
				continue
			}
			writeTo(h, barLine(code, b))
			rows++
		}
		for _, d := range in.Dividends(code) {
			if d.ExDate.After(cutoff) {
				continue
			}
			writeTo(h, divLine(code, d))
			rows++
		}
		if rows == 0 {
			continue
		}
		out[code] = Digest{Rows: rows, Sum: hex.EncodeToString(h.Sum(nil)[:digestBytes])}
	}
	return out
}

// ChangedCodes lists the codes whose digests differ between two runs, or that
// appear in only one of them, sorted. A run's digests are taken at that run's own
// cut-off, so an ordinary append never lists a code.
func ChangedCodes(prev, cur map[string]Digest) []string {
	seen := map[string]bool{}
	var out []string
	for code, d := range prev {
		seen[code] = true
		if c, ok := cur[code]; !ok || c != d {
			out = append(out, code)
		}
	}
	for code := range cur {
		if !seen[code] {
			out = append(out, code)
		}
	}
	sort.Strings(out)
	return out
}

// publishedTrade is a trade with its floats rounded to the output quantum.
type publishedTrade struct {
	Code           string
	SignalDate     string
	EntryDate      string
	EntryPrice     float64
	EntryFill      float64
	Pivot          float64
	EntryScore     float64
	ExitSignalDate string
	ExitDate       string
	ExitPrice      float64
	ExitFill       float64
	ExitReason     string
	Qty            float64
	Gross          float64
	Net            float64
	SessionsHeld   int
	Dividends      float64
	Fees           float64
	Flags          []string
	OpenAtEnd      bool
}

// publishedDay is one recorded session of the daily series.
type publishedDay struct {
	Date   string
	Equity float64
}

func round6(x float64) float64 { return math.Round(x*outputRound) / outputRound }

// PublishedOutputHash is output_hash: SHA-256 of the canonical JSON of the
// trades and the daily series, every float rounded to 1e-6. It is the fingerprint a
// published run stores. Result.OutputHash is the engine's determinism fingerprint
// of the unrounded records, events and trades, and is kept for the golden gates.
func PublishedOutputHash(res Result) (string, error) {
	trades := make([]publishedTrade, 0, len(res.Trades))
	for _, t := range res.Trades {
		trades = append(trades, publishedTrade{
			Code: t.Code, SignalDate: t.SignalDate.String(), EntryDate: t.EntryDate.String(),
			EntryPrice: round6(t.EntryPrice), EntryFill: round6(t.EntryFill), Pivot: round6(t.Pivot),
			EntryScore: round6(t.EntryScore), ExitSignalDate: t.ExitSignalDate.String(), ExitDate: t.ExitDate.String(),
			ExitPrice: round6(t.ExitPrice), ExitFill: round6(t.ExitFill), ExitReason: t.ExitReason,
			Qty: round6(t.Qty), Gross: round6(t.Gross), Net: round6(t.Net), SessionsHeld: t.SessionsHeld,
			Dividends: round6(t.Dividends), Fees: round6(t.Fees), Flags: t.Flags, OpenAtEnd: t.OpenAtEnd,
		})
	}
	days := make([]publishedDay, 0, len(res.Records))
	for _, r := range res.Records {
		days = append(days, publishedDay{Date: r.Date.String(), Equity: round6(r.Equity)})
	}
	b, err := json.Marshal(struct {
		Trades []publishedTrade
		Daily  []publishedDay
	}{trades, days})
	if err != nil {
		return "", fmt.Errorf("backtest: hashing the published output: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// WindowKey is the window a run covers, for its run key: the recipe's window
// start and the last recorded session.
func WindowKey(r spec.Recipe, sessions []civil.Date) string {
	if len(sessions) == 0 {
		return r.WindowStart + ".."
	}
	return r.WindowStart + ".." + sessions[len(sessions)-1].String()
}

// RunIdentity is what a run is identified by beyond its rules and recipe.
type RunIdentity struct {
	// VariantID is empty for a canonical run.
	VariantID string
	InputHash string
	Window    string
}

// RunKey is SHA-256 of rules_hash|recipe_hash|engine_version|window|returns|
// benchmark|fundamentals|variant_id|input_hash. An identical rerun has the
// same key. Two users' identical variants differ by their variant ids, so they
// never share a run.
func RunKey(s spec.Spec, r spec.Recipe, id RunIdentity) (string, error) {
	rules, err := spec.RulesHash(s)
	if err != nil {
		return "", fmt.Errorf("backtest: rules hash: %w", err)
	}
	recipe, err := spec.RecipeHash(r)
	if err != nil {
		return "", fmt.Errorf("backtest: recipe hash: %w", err)
	}
	joined := strings.Join([]string{
		rules, recipe, engine.Version, id.Window, r.Returns, r.Benchmark, r.Fundamentals, id.VariantID, id.InputHash,
	}, "|")
	sum := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(sum[:]), nil
}
