package ownership

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// fakeRepairStore is the repair's database in memory. A removal call is one
// transaction: each URL it names loses its notice row and its attempt together,
// so the fake records both deletes from that one call.
type fakeRepairStore struct {
	rows       []storedNotice
	failRead   bool
	failRemove bool

	transactions    int
	deletedNotices  []string
	deletedAttempts []string
}

func (f *fakeRepairStore) StoredNotices(context.Context) ([]storedNotice, error) {
	if f.failRead {
		return nil, errors.New("db down")
	}
	return f.rows, nil
}

func (f *fakeRepairStore) RemoveNoticesAndAttempts(_ context.Context, urls []string) (int64, int64, error) {
	if f.failRemove {
		return 0, 0, errors.New("db down")
	}
	f.transactions++
	f.deletedNotices = append(f.deletedNotices, urls...)
	f.deletedAttempts = append(f.deletedAttempts, urls...)
	return int64(len(urls)), int64(len(urls)), nil
}

// recordPings returns a ping that appends each request it receives.
func recordPings(pings *[]platform.RevalidateRequest) func(platform.RevalidateRequest) {
	return func(r platform.RevalidateRequest) { *pings = append(*pings, r) }
}

// repairRows is the stored table for the cases the repair has to tell apart: a
// placeholder that reached a row before the gate, one that only tidies to a
// placeholder, a holder whose clause points at an annexure, a holder with a
// boilerplate tail, a row whose name was never read, a placeholder the pass keyed
// to an institution, and names that resolve to an institution.
func repairRows() []storedNotice {
	syr, cba, mqg, tail := 6.0049, 5.01, 7.2, 9.1
	return []storedNotice{
		{URL: "syr", StockCode: "SYR", HolderKey: "name:see annexure 1", HolderName: "SEE ANNEXURE 1", PresentPct: &syr, AnnouncedOn: "2026-10-20", Form: "603"},
		{URL: "cba", StockCode: "CAR", HolderKey: "name:citigroup global markets australia pty limited, as listed in annexure a", HolderName: "Citigroup Global Markets Australia Pty Limited, as listed in Annexure A", PresentPct: &cba, AnnouncedOn: "2026-09-25", Form: "603"},
		{URL: "mqg", StockCode: "ABC", HolderKey: "name:macquarie group limited", HolderName: "Macquarie Group Limited and its associates", PresentPct: &mqg, AnnouncedOn: "2026-09-01", Form: "604"},
		{URL: "tidy", StockCode: "DEF", HolderKey: "name:see annexure 1", HolderName: "SEE ANNEXURE 1 on behalf of Some Fund Pty Ltd", PresentPct: &mqg, AnnouncedOn: "2026-08-01", Form: "605"},
		{URL: "na", StockCode: "GHI", HolderKey: "name:n/a", HolderName: "N/A", AnnouncedOn: "2026-07-01", Form: "603"},
		{URL: "unnamed", StockCode: "JKL", HolderKey: "commonwealth-bank", AnnouncedOn: "2026-06-01", Form: "603"},
		{URL: "tail", StockCode: "MNO", HolderKey: "blackrock", HolderName: "SEE ANNEXURE A", PresentPct: &tail, AnnouncedOn: "2026-10-01", Form: "605", Ceased: true},
		{URL: "blackrock-annex", StockCode: "QRS", HolderKey: "blackrock", HolderName: "Annexure A: BlackRock Inc", AnnouncedOn: "2026-10-02", Form: "603"},
		{URL: "vanguard-refer", StockCode: "TUV", HolderKey: "vanguard", HolderName: "Refer Annexure A for Vanguard Group entities", AnnouncedOn: "2026-10-03", Form: "604"},
	}
}

// The selection judges each stored name by the gate's rule (placeholderHolder). A
// placeholder is listed; one keyed to an institution is listed as kept; a name
// that resolves to an institution is no placeholder at all, and a row with no
// name is none either.
func TestPlaceholderRowsJudgesStoredNames(t *testing.T) {
	got := map[string]placeholderRow{}
	for _, p := range placeholderRows(repairRows()) {
		got[p.URL] = p
	}
	want := map[string]struct {
		reason string
		kept   bool
	}{
		"syr":  {`matches "annexure"`, false},
		"tidy": {`matches "annexure"`, false},
		"na":   {`matches "n/a"`, false},
		"tail": {`matches "annexure"`, true},
	}
	if len(got) != len(want) {
		t.Errorf("listed %d rows, want %d: %+v", len(got), len(want), got)
	}
	for url, w := range want {
		p, ok := got[url]
		if !ok {
			t.Errorf("%s is not listed", url)
			continue
		}
		if p.Reason != w.reason || p.Kept != w.kept {
			t.Errorf("%s: reason %q kept %v, want %q kept %v", url, p.Reason, p.Kept, w.reason, w.kept)
		}
	}
}

// -apply removes the placeholder notices that are not keyed to an institution,
// and their attempts, and nothing else. The removal is one call, so both deletes
// run in one transaction.
func TestRepairPlaceholdersApplyRemovesMatchedInOneTransaction(t *testing.T) {
	// No web tier to ping: the revalidation has nothing to reach.
	t.Setenv("REVALIDATION_URL", "")
	t.Setenv("REVALIDATION_SECRET", "")
	store := &fakeRepairStore{rows: repairRows()}
	var pings []platform.RevalidateRequest
	if err := repairPlaceholders(context.Background(), store, config{mode: modeRepairPlaceholders, apply: true}, recordPings(&pings)); err != nil {
		t.Fatal(err)
	}
	want := []string{"syr", "tidy", "na"}
	if store.transactions != 1 {
		t.Fatalf("%d removal transactions, want 1", store.transactions)
	}
	if !slices.Equal(store.deletedNotices, want) || !slices.Equal(store.deletedAttempts, want) {
		t.Errorf("deleted notices %v and attempts %v, want %v in both", store.deletedNotices, store.deletedAttempts, want)
	}
	// The rows that were not withheld are never deleted: a kept institution row, a
	// name that resolves, a row with no name, and a holder whose clause points at
	// an annexure.
	for _, url := range []string{"cba", "mqg", "unnamed", "tail", "blackrock-annex", "vanguard-refer"} {
		if slices.Contains(store.deletedNotices, url) || slices.Contains(store.deletedAttempts, url) {
			t.Errorf("%s was deleted, but the gate keeps it", url)
		}
	}
}

// Without -apply nothing is removed, and the listing is all a run prints. -apply
// while the job is still a dry run removes nothing either, and fails, so the
// request is not reported as done.
func TestRepairPlaceholdersDryRunWritesNothing(t *testing.T) {
	for _, cfg := range []config{
		{mode: modeRepairPlaceholders, dryRun: true},
		{mode: modeRepairPlaceholders, dryRun: false},
	} {
		store := &fakeRepairStore{rows: repairRows()}
		var pings []platform.RevalidateRequest
		if err := repairPlaceholders(context.Background(), store, cfg, recordPings(&pings)); err != nil {
			t.Fatalf("%+v: %v", cfg, err)
		}
		if store.transactions != 0 || len(pings) != 0 {
			t.Errorf("%+v removed %v and pinged %d times", cfg, store.deletedNotices, len(pings))
		}
	}
}

// -apply on a dry run is a failure with exit 1, and removes nothing.
func TestRepairPlaceholdersApplyOnDryRunFails(t *testing.T) {
	store := &fakeRepairStore{rows: repairRows()}
	var pings []platform.RevalidateRequest
	err := repairPlaceholders(context.Background(), store, config{mode: modeRepairPlaceholders, dryRun: true, apply: true}, recordPings(&pings))
	if err == nil || runner.ExitCodeOf(err) != 1 {
		t.Fatalf("-apply on a dry run = %v (exit %d), want an error with exit 1", err, runner.ExitCodeOf(err))
	}
	if store.transactions != 0 || len(pings) != 0 {
		t.Errorf("-apply on a dry run removed %v and pinged %d times", store.deletedNotices, len(pings))
	}
}

// A store with no placeholder exits 0 and says so, and touches no row.
func TestRepairPlaceholdersNothingToRepair(t *testing.T) {
	store := &fakeRepairStore{rows: []storedNotice{
		{URL: "cba", StockCode: "CAR", HolderName: "Citigroup Global Markets Australia Pty Limited, as listed in Annexure A"},
		{URL: "mqg", StockCode: "ABC", HolderName: "Macquarie Group Limited and its associates"},
		{URL: "unnamed", StockCode: "JKL"},
	}}
	var pings []platform.RevalidateRequest
	if err := repairPlaceholders(context.Background(), store, config{mode: modeRepairPlaceholders, apply: true}, recordPings(&pings)); err != nil {
		t.Fatalf("nothing to repair: %v", err)
	}
	if store.transactions != 0 || len(pings) != 0 {
		t.Errorf("removed %v and pinged %d times with nothing to repair", store.deletedNotices, len(pings))
	}
}

// A placeholder keyed to an institution is listed and kept: -apply removes
// nothing, exits 0, and does not ping.
func TestRepairPlaceholdersKeepsInstitutionRows(t *testing.T) {
	store := &fakeRepairStore{rows: []storedNotice{
		{URL: "tail", StockCode: "MNO", HolderKey: "blackrock", HolderName: "SEE ANNEXURE A", AnnouncedOn: "2026-10-01", Form: "605", Ceased: true},
	}}
	var pings []platform.RevalidateRequest
	if err := repairPlaceholders(context.Background(), store, config{mode: modeRepairPlaceholders, apply: true}, recordPings(&pings)); err != nil {
		t.Fatalf("only kept rows: %v", err)
	}
	if store.transactions != 0 || len(pings) != 0 {
		t.Errorf("removed %v and pinged %d times for a kept row", store.deletedNotices, len(pings))
	}
}

// A database error exits 1 and removes nothing.
func TestRepairPlaceholdersDatabaseErrors(t *testing.T) {
	for name, store := range map[string]*fakeRepairStore{
		"reading":  {rows: repairRows(), failRead: true},
		"removing": {rows: repairRows(), failRemove: true},
	} {
		var pings []platform.RevalidateRequest
		err := repairPlaceholders(context.Background(), store, config{mode: modeRepairPlaceholders, apply: true}, recordPings(&pings))
		if err == nil || runner.ExitCodeOf(err) != 1 {
			t.Errorf("%s: %v (exit %d), want an error with exit 1", name, err, runner.ExitCodeOf(err))
		}
		if store.transactions != 0 || len(pings) != 0 {
			t.Errorf("%s: removed rows or pinged despite the error", name)
		}
	}
}

// The web tier is pinged exactly once after rows are removed, and not otherwise:
// not on a dry run, not when nothing matched or only institution rows matched,
// not when the removal failed, and not when the web tier is not configured.
func TestRepairPlaceholdersPingsOnlyAfterARemoval(t *testing.T) {
	apply := config{mode: modeRepairPlaceholders, apply: true}
	cbaOnly := []storedNotice{{URL: "cba", StockCode: "CAR", HolderName: "Citigroup Global Markets Australia Pty Limited, as listed in Annexure A"}}
	keptOnly := []storedNotice{{URL: "tail", StockCode: "MNO", HolderKey: "blackrock", HolderName: "SEE ANNEXURE A", Form: "605", Ceased: true}}
	for _, tc := range []struct {
		name  string
		rows  []storedNotice
		cfg   config
		fail  bool
		web   bool
		pings int
	}{
		{"removal", repairRows(), apply, false, true, 1},
		{"removal, no web tier", repairRows(), apply, false, false, 0},
		{"dry run", repairRows(), config{mode: modeRepairPlaceholders, dryRun: true}, false, true, 0},
		{"apply on a dry run", repairRows(), config{mode: modeRepairPlaceholders, dryRun: true, apply: true}, false, true, 0},
		{"nothing matched", cbaOnly, apply, false, true, 0},
		{"only kept rows", keptOnly, apply, false, true, 0},
		{"removal failed", repairRows(), apply, true, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REVALIDATION_URL", "")
			t.Setenv("REVALIDATION_SECRET", "")
			if tc.web {
				t.Setenv("REVALIDATION_URL", "https://web.example/api/revalidate")
				t.Setenv("REVALIDATION_SECRET", "test-secret")
			}
			store := &fakeRepairStore{rows: tc.rows, failRemove: tc.fail}
			var pings []platform.RevalidateRequest
			_ = repairPlaceholders(context.Background(), store, tc.cfg, recordPings(&pings))
			if len(pings) != tc.pings {
				t.Fatalf("%d pings, want %d: %+v", len(pings), tc.pings, pings)
			}
			if tc.pings == 1 && (pings[0].Tag != "ownership" || pings[0].Flush != "ownership") {
				t.Errorf("ping %+v, want tag and flush ownership", pings[0])
			}
		})
	}
}

// The repair removes exactly the notices the gate withholds. For each section 1
// name, the gate's verdict on the notice must match the repair's verdict on the
// row the pass stores for that name (resolveHolder keys it as the pass does).
func TestRepairAgreesWithGate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		withheld bool
	}{
		{"SEE ANNEXURE 1", true},
		{"SEE ANNEXURE 1 on behalf of Some Fund Pty Ltd", true},
		{"Refer to Annexure A", true},
		{"N/A", true},
		{"Some Fund Pty Ltd", false},
		{"Citigroup Global Markets Australia Pty Limited, as listed in Annexure A", false},
		{"Annexure A: BlackRock Inc.", false},
		{"Refer Annexure A for Vanguard Group entities", false},
		{"SEE ANNEXURE A (BlackRock Inc. and its subsidiaries)", false},
	} {
		_, outcome, detail := parseSubstantialNotice(placeholderNotice(tc.name), "")
		if withheld := outcome == outcomeNoHolder; withheld != tc.withheld {
			t.Errorf("gate on %q: %s (%s), want withheld %v", tc.name, outcome, detail, tc.withheld)
		}
		stored, ok := resolveHolder(Notice{HolderName: cleanHolderName(tc.name)}, "", nil)
		if !ok {
			t.Fatalf("%q: the pass stores no holder for it", tc.name)
		}
		row := storedNotice{URL: tc.name, StockCode: "XYZ", HolderKey: stored.Key, HolderName: stored.Name, AnnouncedOn: "2026-10-20", Form: "603"}
		removable := 0
		for _, p := range placeholderRows([]storedNotice{row}) {
			if !p.Kept {
				removable++
			}
		}
		if (removable == 1) != tc.withheld {
			t.Errorf("repair on %q: %d removable (stored as %+v), want removable %v", tc.name, removable, row, tc.withheld)
		}
	}
}

// The listing is one line per row, with the inputs an operator judges a row by.
// The voting power prints at four places, and a kept row carries its note.
func TestPlaceholderLine(t *testing.T) {
	syr := 6.0049
	line := placeholderLine(placeholderRow{
		storedNotice: storedNotice{URL: "https://announcements.example/syr.pdf", StockCode: "SYR", HolderKey: "name:see annexure 1",
			HolderName: "SEE ANNEXURE 1", PresentPct: &syr, AnnouncedOn: "2026-10-20", Form: "603"},
		Reason: `matches "annexure"`,
	})
	want := `SYR "SEE ANNEXURE 1" key=name:see annexure 1 form=603 ceased=false present=6.0049% announced=2026-10-20 https://announcements.example/syr.pdf (matches "annexure")`
	if line != want {
		t.Errorf("line\n%q\nwant\n%q", line, want)
	}

	kept := placeholderLine(placeholderRow{
		storedNotice: storedNotice{URL: "https://announcements.example/tail.pdf", StockCode: "MNO", HolderKey: "blackrock",
			HolderName: "SEE ANNEXURE A", AnnouncedOn: "2026-10-01", Form: "605", Ceased: true},
		Reason: `matches "annexure"`,
		Kept:   true,
	})
	wantKept := `MNO "SEE ANNEXURE A" key=blackrock form=605 ceased=true present=- announced=2026-10-01 https://announcements.example/tail.pdf (matches "annexure") NOTE: keyed to institution blackrock, so kept, not removed: its name resolves to it, and a re-read would store it again; removing a ceased notice would bring an earlier holding back as current`
	if kept != wantKept {
		t.Errorf("kept line\n%q\nwant\n%q", kept, wantKept)
	}
	// A removable row that ceased carries the warning too, and no kept-row note.
	ceased := placeholderLine(placeholderRow{
		storedNotice: storedNotice{URL: "https://announcements.example/old.pdf", StockCode: "DEF", HolderKey: "name:see annexure 1",
			HolderName: "SEE ANNEXURE 1", AnnouncedOn: "2026-08-01", Form: "605", Ceased: true},
		Reason: `matches "annexure"`,
	})
	wantCeased := `DEF "SEE ANNEXURE 1" key=name:see annexure 1 form=605 ceased=true present=- announced=2026-08-01 https://announcements.example/old.pdf (matches "annexure") NOTE: ceased, so removing it can bring an earlier holding for this key back as current in v_substantial_holdings_current`
	if ceased != wantCeased {
		t.Errorf("ceased line\n%q\nwant\n%q", ceased, wantCeased)
	}
	if strings.Contains(kept, "\n") || strings.Contains(line, "\n") || strings.Contains(ceased, "\n") {
		t.Error("a listing line spans more than one line")
	}
}
