package backtest

import (
	"fmt"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Disclosures is everything a published run carries beside its metrics: the
// coverage of both measures, the survivorship block, the data-quality counts, the
// same-data reference, the sensitivity runs, the windows and the identity hashes.
type Disclosures struct {
	Coverage     Coverage
	Survivorship Survivorship
	DataQuality  DataQuality
	Reference    WindowFigures
	Sensitivity  Sensitivities
	Windows      []WindowFigures
	Identity     Identity
}

// Identity is a run's fingerprint and provenance. The diff note is built
// from ChangedCodes over the previous run's digests, taken at that run's cut-off.
type Identity struct {
	InputHash     string
	OutputHash    string
	RunKey        string
	CutOff        civil.Date
	InSampleUntil civil.Date
	PricesThrough civil.Date
	Digests       map[string]Digest
	BuildRevision string
}

// Disclose runs recipe r under version s over the rows in in and assembles its
// disclosures. liveFrom is the version's live_from; paper, when given, is the paper
// track, which the Since windows chain onto and the Live since freeze window is
// measured on. pricesThrough is the newest price session the run reads. build is
// the build revision the caller records (the VCS revision, or the image tag); the
// pure package reads no build information of its own. variantID is empty for a
// canonical run and names a user's variant otherwise, so two identical variants
// never share a run key.
func Disclose(in Inputs, s spec.Spec, r spec.Recipe, liveFrom civil.Date, paper *Series,
	pricesThrough civil.Date, build, variantID string) (Disclosures, Result, error) {
	p, err := prepare(in, s, r, false)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	base, err := simulate(p)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	if len(base.Sessions) == 0 {
		return Disclosures{}, Result{}, fmt.Errorf("backtest: the run recorded no sessions")
	}
	var d Disclosures
	d.Sensitivity, err = sensitivitiesOf(in, s, r, p, base)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	d.Coverage, err = MeasureCoverage(in, s, base.Sessions, CoverageMinPct)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	d.Survivorship = SurvivorshipOf(r)
	d.DataQuality = DataQualityOf(base)

	ref, err := Reference(in, s, r, base.Sessions)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	d.Reference = figuresOfWindow("reference", "Same-data reference", ref.Basis, ref.Curve, nil, "")
	// The reference level of every recorded session is part of the run's stored series, so a
	// published run carries the curve it is compared with, aligned by date (the reference is
	// the same sessions as the run, so a mismatch is a bug and refused).
	if err := withReference(base.Records, ref.Curve); err != nil {
		return Disclosures{}, Result{}, err
	}

	bt := Series{Basis: BasisTotal, Curve: EquityCurve(base.Records)}
	d.Windows, err = Windows(bt, paper, liveFrom, in.Market().CashRate)
	if err != nil {
		return Disclosures{}, Result{}, err
	}

	inputHash, err := InputHash(in)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	outputHash, err := PublishedOutputHash(base)
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	key, err := RunKey(s, r, RunIdentity{VariantID: variantID, InputHash: inputHash, Window: WindowKey(r, base.Sessions)})
	if err != nil {
		return Disclosures{}, Result{}, err
	}
	d.Identity = Identity{
		InputHash:     inputHash,
		OutputHash:    outputHash,
		RunKey:        key,
		CutOff:        CutOff(pricesThrough),
		InSampleUntil: InSampleUntil(liveFrom),
		PricesThrough: pricesThrough,
		Digests:       CodeDigests(in, CutOff(pricesThrough)),
		BuildRevision: build,
	}
	return d, base, nil
}

// withReference writes the reference curve's level into each record of the run, by date.
func withReference(recs []Record, ref Curve) error {
	if len(recs) != len(ref.Dates) {
		return fmt.Errorf("backtest: the reference covers %d sessions, the run records %d", len(ref.Dates), len(recs))
	}
	for i := range recs {
		if recs[i].Date != ref.Dates[i] {
			return fmt.Errorf("backtest: the reference is not aligned with the run at %s", recs[i].Date)
		}
		recs[i].Reference = ref.Values[i]
	}
	return nil
}
