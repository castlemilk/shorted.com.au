package backtest

import (
	"strings"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// TestCutOffIsTheLastMonthEndBeforePricesThrough: the cut-off is the last day of
// the last month that closed before prices_through, so a month still open is
// never in a digest.
func TestCutOffIsTheLastMonthEndBeforePricesThrough(t *testing.T) {
	for _, c := range []struct{ through, want civil.Date }{
		{civil.Date{Year: 2026, Month: 11, Day: 5}, civil.Date{Year: 2026, Month: 10, Day: 31}},
		{civil.Date{Year: 2026, Month: 11, Day: 1}, civil.Date{Year: 2026, Month: 10, Day: 31}},
		{civil.Date{Year: 2026, Month: 10, Day: 31}, civil.Date{Year: 2026, Month: 9, Day: 30}},
		{civil.Date{Year: 2024, Month: 3, Day: 1}, civil.Date{Year: 2024, Month: 2, Day: 29}},
	} {
		if got := CutOff(c.through); got != c.want {
			t.Fatalf("CutOff(%s) = %s, want %s", c.through, got, c.want)
		}
	}
}

// identityInputs is the golden market, loaded afresh so a test may change it.
func identityInputs(t *testing.T) *MemoryInputs {
	t.Helper()
	in := loadGolden(t)
	in.Funds = map[string]features.Fundamentals{}
	for _, code := range in.Codes() {
		in.Funds[code] = features.Fundamentals{Hash: "h-" + code, Blob: []byte(`{"growth":null}`)}
	}
	return in
}

// TestInputHashCoversEveryInput: changing any row a run reads changes the hash,
// and the hash does not depend on the order the rows arrive in.
func TestInputHashCoversEveryInput(t *testing.T) {
	base, err := InputHash(identityInputs(t))
	if err != nil {
		t.Fatal(err)
	}
	code := loadGolden(t).Codes()[0]
	mutations := map[string]func(m *MemoryInputs){
		"a bar close":  func(m *MemoryInputs) { m.BarsByCode[code][3].Close += 0.01 },
		"a bar volume": func(m *MemoryInputs) { m.BarsByCode[code][3].Volume += 1 },
		"a dividend": func(m *MemoryInputs) {
			m.Divs[code] = append(m.Divs[code], features.Dividend{ExDate: civil.Date{Year: 2030, Month: 1, Day: 2}, AmountPerShare: 0.1})
		},
		"fundamentals blob":  func(m *MemoryInputs) { f := m.Funds[code]; f.Blob = []byte(`{"growth":{}}`); m.Funds[code] = f },
		"fundamentals hash":  func(m *MemoryInputs) { f := m.Funds[code]; f.Hash = "other"; m.Funds[code] = f },
		"an index bar":       func(m *MemoryInputs) { m.Mkt.XJO[2].Close += 0.5 },
		"an ASIC row":        func(m *MemoryInputs) { m.Mkt.ASIC[1].Positions += 1 },
		"an ASIC percentage": func(m *MemoryInputs) { v := *m.Mkt.ASIC[1].Percent + 0.1; m.Mkt.ASIC[1].Percent = &v },
		"an ingest":          func(m *MemoryInputs) { m.Mkt.Ingests[0].LoadedRows-- },
		"an ETP flag":        func(m *MemoryInputs) { m.Mkt.ETPs[code] = true },
		"a company name":     func(m *MemoryInputs) { m.Mkt.Names[code] = "Renamed Ltd" },
		"an industry":        func(m *MemoryInputs) { m.Mkt.Industry = map[string]string{code: "Banks"} },
		"the cash rate": func(m *MemoryInputs) {
			m.Mkt.CashRate = append(m.Mkt.CashRate, features.RatePoint{Date: civil.Date{Year: 2031, Month: 1, Day: 1}, Rate: 3})
		},
	}
	for name, mutate := range mutations {
		in := identityInputs(t)
		mutate(in)
		got, err := InputHash(in)
		if err != nil {
			t.Fatal(err)
		}
		if got == base {
			t.Fatalf("%s: the input hash did not change", name)
		}
	}

	shuffled := identityInputs(t)
	for i, j := 0, len(shuffled.Mkt.ASIC)-1; i < j; i, j = i+1, j-1 {
		shuffled.Mkt.ASIC[i], shuffled.Mkt.ASIC[j] = shuffled.Mkt.ASIC[j], shuffled.Mkt.ASIC[i]
	}
	got, err := InputHash(shuffled)
	if err != nil {
		t.Fatal(err)
	}
	if got != base {
		t.Fatalf("reordering the ASIC rows changed the input hash")
	}
}

// TestCodeDigestsIgnoreRowsAfterTheCutOff: a bar appended after the cut-off does
// not change any digest, and a bar rewritten before it changes only its code's.
func TestCodeDigestsIgnoreRowsAfterTheCutOff(t *testing.T) {
	in := loadGolden(t)
	code := in.Codes()[0]
	last := in.BarsByCode[code][len(in.BarsByCode[code])-1].Date
	cut := last.AddDays(-30)
	base := CodeDigests(in, cut)

	appended := loadGolden(t)
	b := appended.BarsByCode[code][len(appended.BarsByCode[code])-1]
	b.Date = last.AddDays(1)
	appended.BarsByCode[code] = append(appended.BarsByCode[code], b)
	if got := ChangedCodes(base, CodeDigests(appended, cut)); len(got) != 0 {
		t.Fatalf("a row after the cut-off changed digests of %v", got)
	}

	rewritten := loadGolden(t)
	rewritten.BarsByCode[code][0].Close += 0.01
	if got := ChangedCodes(base, CodeDigests(rewritten, cut)); len(got) != 1 || got[0] != code {
		t.Fatalf("a rewritten row changed %v, want [%s]", got, code)
	}
}

// TestChangedCodesListsAddedAndRemovedCodes: a code in one digest set and not the
// other is a change, and identical sets have none.
func TestChangedCodesListsAddedAndRemovedCodes(t *testing.T) {
	a := map[string]Digest{"AAA": {Rows: 3, Sum: "x"}, "BBB": {Rows: 1, Sum: "y"}}
	b := map[string]Digest{"AAA": {Rows: 3, Sum: "x"}, "CCC": {Rows: 2, Sum: "z"}}
	got := ChangedCodes(a, b)
	if strings.Join(got, ",") != "BBB,CCC" {
		t.Fatalf("changed %v, want [BBB CCC]", got)
	}
	if len(ChangedCodes(a, a)) != 0 {
		t.Fatalf("identical digests list changes")
	}
}

// TestPublishedOutputHashRoundsToAMillionth: the output hash is stable under a
// change below 1e-6 and moves for one above it.
func TestPublishedOutputHashRoundsToAMillionth(t *testing.T) {
	day := civil.Date{Year: 2024, Month: 1, Day: 2}
	res := func(eq float64) Result {
		return Result{Records: []Record{{Date: day, Equity: eq}}}
	}
	base, err := PublishedOutputHash(res(100000))
	if err != nil {
		t.Fatal(err)
	}
	near, _ := PublishedOutputHash(res(100000 + 1e-9))
	if near != base {
		t.Fatalf("a change of 1e-9 moved the published output hash")
	}
	far, _ := PublishedOutputHash(res(100000 + 1e-3))
	if far == base {
		t.Fatalf("a change of 1e-3 did not move the published output hash")
	}
	if len(base) != 64 {
		t.Fatalf("hash %q is not 64 hex characters", base)
	}
}

// TestRunKeyNamesEverythingThatDeterminesTheRun: an identical rerun has the same
// key; a variant id, an input change or a window change gives another.
func TestRunKeyNamesEverythingThatDeterminesTheRun(t *testing.T) {
	s := goldenSpec(t)
	r := goldenRecipe(t)
	id := RunIdentity{InputHash: "in", Window: WindowKey(r, []civil.Date{{Year: 2025, Month: 9, Day: 5}})}
	base, err := RunKey(s, r, id)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := RunKey(s, r, id)
	if again != base {
		t.Fatalf("an identical rerun has key %s, want %s", again, base)
	}
	for name, other := range map[string]RunIdentity{
		"variant": {VariantID: "v1", InputHash: id.InputHash, Window: id.Window},
		"input":   {InputHash: "other", Window: id.Window},
		"window":  {InputHash: id.InputHash, Window: "2019-05-01..2024-01-02"},
	} {
		got, err := RunKey(s, r, other)
		if err != nil {
			t.Fatal(err)
		}
		if got == base {
			t.Fatalf("%s did not change the run key", name)
		}
	}
	// The rules and the recipe are in the key too.
	s2 := s
	s2.Data.PublicationLagSessions++
	if got, _ := RunKey(s2, r, id); got == base {
		t.Fatalf("a rules change did not change the run key")
	}
	r2 := r
	r2.CooldownSessions++
	if got, _ := RunKey(s, r2, id); got == base {
		t.Fatalf("a recipe change did not change the run key")
	}
}

// TestGoldenDisclosureIdentityIsStable: the disclosures of the golden run carry the
// same identity twice over, and a run's input hash is the golden's.
func TestGoldenDisclosureIdentityIsStable(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	r := goldenRecipe(t)
	live := civil.Date{Year: 2023, Month: 9, Day: 1}
	through := civil.Date{Year: 2025, Month: 9, Day: 8}
	d1, _, err := Disclose(in, s, r, live, nil, through, "tag")
	if err != nil {
		t.Fatal(err)
	}
	d2, _, err := Disclose(loadGolden(t), s, r, live, nil, through, "tag")
	if err != nil {
		t.Fatal(err)
	}
	if d1.Identity.InputHash != d2.Identity.InputHash || d1.Identity.OutputHash != d2.Identity.OutputHash || d1.Identity.RunKey != d2.Identity.RunKey {
		t.Fatalf("the golden run's identity differs between two runs")
	}
	if d1.Identity.CutOff != (civil.Date{Year: 2025, Month: 8, Day: 31}) || d1.Identity.InSampleUntil != (civil.Date{Year: 2023, Month: 8, Day: 31}) {
		t.Fatalf("cut-off %s, in-sample until %s", d1.Identity.CutOff, d1.Identity.InSampleUntil)
	}
	if d1.Identity.BuildRevision != "tag" {
		t.Fatalf("build revision %q, want the one the caller recorded", d1.Identity.BuildRevision)
	}
	if len(d1.Identity.Digests) == 0 {
		t.Fatalf("no per-code digests")
	}
}
