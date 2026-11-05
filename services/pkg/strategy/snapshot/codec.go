package snapshot

import (
	"encoding/json"
	"fmt"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Meta is a stored row's meta object: the display facts and the fallbacks the
// candidate reads that the price and short features do not carry. Its keys are
// the stored names; a reader of stored rows depends on them.
type Meta struct {
	Name           string   `json:"name,omitempty"`
	Industry       string   `json:"industry,omitempty"`
	LogoURL        string   `json:"logo_url,omitempty"`
	MarketCap      *float64 `json:"market_cap"`
	PricedSessions int      `json:"priced_sessions"` // priced bars in the 400-day lookback
}

// Universe reasons the snapshot writes, named as the stock page shows them.
const (
	ReasonNoBarOnSession = "no_bar_on_session"
	ReasonShortHistory   = "short_history"
)

// EncodeFeatures is the stored features object: the JSON the row's features column holds.
func EncodeFeatures(f Features) ([]byte, error) {
	return json.Marshal(f)
}

// DecodeFeatures reads a stored features object back.
func DecodeFeatures(raw []byte) (Features, error) {
	var f Features
	if err := json.Unmarshal(raw, &f); err != nil {
		return Features{}, fmt.Errorf("decode snapshot features: %w", err)
	}
	return f, nil
}

// EncodeMeta is the stored meta object.
func EncodeMeta(m Meta) (json.RawMessage, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("encode snapshot meta: %w", err)
	}
	return raw, nil
}

// DecodeMeta reads a stored meta object back. An empty object is the zero Meta.
func DecodeMeta(raw json.RawMessage) (Meta, error) {
	var m Meta
	if len(raw) == 0 {
		return m, nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return Meta{}, fmt.Errorf("decode snapshot meta: %w", err)
	}
	return m, nil
}

// HasPrice reports whether the row carries the price features of an eligible
// session: the feature function ran on it, so its date is set.
func (r Row) HasPrice() bool {
	return !r.Features.FS1.AsOf.IsZero()
}

// Eligible reports whether a stored row is in the version's universe on its
// session, and the reason when it is not. The version's universe policy is
// read from s; the universe facts are the ones the row stores (4.7):
//
//   - the instruments-all universe (v0) needs price features and at least
//     MinSessions priced sessions in the lookback;
//   - the ordinary universe needs ordinary_fresh_60, and a version that
//     names the ASIC report (Crowded-Short) also needs in_asic_report.
func Eligible(r Row, s spec.Spec) (bool, string) {
	meta, err := DecodeMeta(r.Meta)
	if err != nil {
		return false, ReasonShortHistory
	}
	if s.Universe.Instruments == "all" {
		if !r.HasPrice() || meta.PricedSessions < s.Universe.MinSessions {
			return false, ReasonShortHistory
		}
		return true, ""
	}
	if !r.OrdinaryFresh60 {
		if r.IneligibleReason != "" {
			return false, r.IneligibleReason
		}
		return false, ReasonNoBarOnSession
	}
	if s.Universe.ASICReported && !r.InASICReport {
		return false, "not_in_asic_report"
	}
	return true, ""
}

// ToCandidate rebuilds one stored row as the evaluator's candidate under the
// version s. The price features are the stored fs1 object, the short reading
// is sf0 or sf1 as the version's short source names, and the fundamentals are
// the blob the row points at (f; zero when the row has none). The result is
// not prepared: the caller runs engine.PrepareCandidates on the universe.
func ToCandidate(r Row, s spec.Spec, f features.Fundamentals) (engine.Candidate, error) {
	meta, err := DecodeMeta(r.Meta)
	if err != nil {
		return engine.Candidate{}, err
	}
	c := pipeline.CandidateFromPrice(r.StockCode, r.Features.FS1)
	sr := r.Features.SF0
	if s.Data.ShortSource == "latest_complete_published" {
		sr = r.Features.SF1
	}
	c.ShortPct = sr.Pct
	c.DaysToCover = sr.DaysToCover
	if sr.ReportDate != nil {
		t := dateTime(*sr.ReportDate)
		c.ShortReportDate = &t
	}
	c.CompanyName = meta.Name
	c.Industry = meta.Industry
	c.LogoURL = meta.LogoURL
	if meta.MarketCap != nil {
		v := *meta.MarketCap
		c.MarketCap = &v
	}
	pipeline.ApplyFundamentals(&c, f)
	return c, nil
}

// dateTime is a civil date at UTC midnight, the candidate's time form.
func dateTime(d civil.Date) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
}
