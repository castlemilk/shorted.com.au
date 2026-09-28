package picks

import (
	"context"
	"fmt"
)

// The filings half of the shared test fake. fakeStore (fundamentals_test.go)
// is the vendor stream's; its filing fields (extractions, vendor,
// filingUpserts, filingUpsertErr) predate this plan, so the filing methods the
// filingStore interface gained are defined here, on the same type, over those
// fields. filingFake wraps it for the tests that need read failures, company
// profiles or a stored state.

func (f *fakeStore) VendorRows(context.Context) (map[string][]vendorRow, error) {
	return f.vendor, nil
}

func (f *fakeStore) CompanyProfiles(context.Context) (map[string]companyProfile, error) {
	return map[string]companyProfile{}, nil
}

func (f *fakeStore) StoredFilingState(context.Context) ([]storedFiling, error) { return nil, nil }

// RebuildFilings is one transaction: any code with a filingUpsertErr fails the
// whole rebuild and nothing is recorded; otherwise the complete produced set
// replaces filingUpserts.
func (f *fakeStore) RebuildFilings(_ context.Context, rb filingRebuild) (filingRebuildResult, error) {
	codes := sortedCodes(rb.Rows)
	for _, code := range codes {
		if err := f.filingUpsertErr[code]; err != nil {
			return filingRebuildResult{}, fmt.Errorf("rebuild: %s: %w", code, err)
		}
	}
	f.filingUpserts = map[string][]PeriodRow{}
	res := filingRebuildResult{}
	for _, code := range codes {
		f.filingUpserts[code] = rb.Rows[code]
		res.Upserted += len(rb.Rows[code])
	}
	res.Codes = len(codes)
	return res, nil
}

// filingFake adds read failures, profiles and a stored state to fakeStore, and
// records every rebuild; RebuildFilings answers with planPurge over the stored
// state (the rule the SQL applies).
type filingFake struct {
	*fakeStore
	extErr, vendorErr, profileErr, storedErr, rebuildErr error
	profiles                                             map[string]companyProfile
	stored                                               []storedFiling
	rebuilds                                             []filingRebuild
}

func newFilingFake(exts []filingExtraction, vendor map[string][]vendorRow) *filingFake {
	return &filingFake{fakeStore: &fakeStore{extractions: exts, vendor: vendor}}
}

func (f *filingFake) FilingExtractions(ctx context.Context) ([]filingExtraction, error) {
	if f.extErr != nil {
		return nil, f.extErr
	}
	return f.fakeStore.FilingExtractions(ctx)
}

func (f *filingFake) VendorRows(ctx context.Context) (map[string][]vendorRow, error) {
	if f.vendorErr != nil {
		return nil, f.vendorErr
	}
	return f.fakeStore.VendorRows(ctx)
}

func (f *filingFake) CompanyProfiles(context.Context) (map[string]companyProfile, error) {
	if f.profileErr != nil {
		return nil, f.profileErr
	}
	return f.profiles, nil
}

func (f *filingFake) StoredFilingState(context.Context) ([]storedFiling, error) {
	return f.stored, f.storedErr
}

func (f *filingFake) RebuildFilings(ctx context.Context, rb filingRebuild) (filingRebuildResult, error) {
	if f.rebuildErr != nil {
		return filingRebuildResult{}, f.rebuildErr
	}
	f.rebuilds = append(f.rebuilds, rb)
	res, err := f.fakeStore.RebuildFilings(ctx, rb)
	if err != nil {
		return res, err
	}
	res.Purged, res.Nulled = planPurge(f.stored, rb.Rows)
	return res, nil
}

// logRecorder collects runFilings' log lines.
type logRecorder struct{ lines []string }

func (l *logRecorder) logf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logRecorder) joined() string {
	out := ""
	for _, s := range l.lines {
		out += s + "\n"
	}
	return out
}
