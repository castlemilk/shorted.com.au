package pgsource

import (
	"context"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
)

// Writer is the part of *pgxpool.Pool and pgx.Tx the snapshot writers use, so
// the daily job can write one session in one transaction or a dry run can
// stand in a fake.
type Writer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
}

// snapshotRowBatch is how many feature rows one session writes per round trip.
const snapshotRowBatch = 500

// dateArg is a nullable civil date as a SQL argument.
func dateArg(d *civil.Date) any {
	if d == nil {
		return nil
	}
	return d.String()
}

// textArg is a nullable string as a SQL argument.
func textArg(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// WriteFeatureRows upserts one session's feature rows. Rows are keyed by
// (as_of, feature_set, stock_code), so a re-run of the session replaces its own
// rows and nothing else. Writes go in batches of snapshotRowBatch.
func WriteFeatureRows(ctx context.Context, w Writer, rows []snapshot.Row) error {
	for start := 0; start < len(rows); start += snapshotRowBatch {
		chunk := rows[start:min(start+snapshotRowBatch, len(rows))]
		batch := &pgx.Batch{}
		for _, r := range chunk {
			feats, err := snapshot.EncodeFeatures(r.Features)
			if err != nil {
				return fmt.Errorf("encode features for %s: %w", r.StockCode, err)
			}
			batch.Queue(`
				INSERT INTO strategy_features_daily (
					as_of, feature_set, stock_code, bar_date, ordinary_fresh_60, ineligible_reason,
					is_ordinary, in_asic_report, short_report_date, short_available_date, short_status,
					ca_suspect_date, features, fundamentals_hash, meta)
				VALUES ($1::date, $2, $3, $4::date, $5, $6, $7, $8, $9::date, $10::date, $11, $12::date, $13::jsonb, $14, $15::jsonb)
				ON CONFLICT (as_of, feature_set, stock_code) DO UPDATE SET
					bar_date = EXCLUDED.bar_date, ordinary_fresh_60 = EXCLUDED.ordinary_fresh_60,
					ineligible_reason = EXCLUDED.ineligible_reason, is_ordinary = EXCLUDED.is_ordinary,
					in_asic_report = EXCLUDED.in_asic_report, short_report_date = EXCLUDED.short_report_date,
					short_available_date = EXCLUDED.short_available_date, short_status = EXCLUDED.short_status,
					ca_suspect_date = EXCLUDED.ca_suspect_date, features = EXCLUDED.features,
					fundamentals_hash = EXCLUDED.fundamentals_hash, meta = EXCLUDED.meta`,
				r.AsOf.String(), r.FeatureSet, r.StockCode, dateOrNil(r.BarDate), r.OrdinaryFresh60,
				textArg(r.IneligibleReason), r.IsOrdinary, r.InASICReport,
				dateArg(r.ShortReportDate), dateArg(r.ShortAvailableDate), textArg(r.ShortStatus),
				dateArg(r.CASuspectDate), string(feats), textArg(r.FundamentalsHash), string(metaOrEmpty(r.Meta)))
		}
		if err := sendAll(ctx, w, batch, len(chunk)); err != nil {
			return fmt.Errorf("write feature rows: %w", err)
		}
	}
	return nil
}

// dateOrNil is a zero civil date as NULL, for the bar date of a code with no bar.
func dateOrNil(d civil.Date) any {
	if d.IsZero() {
		return nil
	}
	return d.String()
}

// metaOrEmpty is a row's meta object, or an empty object when it has none.
func metaOrEmpty(raw []byte) []byte {
	if len(raw) == 0 {
		return []byte("{}")
	}
	return raw
}

// sendAll runs a batch and checks every statement's result.
func sendAll(ctx context.Context, w Writer, batch *pgx.Batch, n int) error {
	br := w.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for i := 0; i < n; i++ {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// WriteFundamentalsBlobs stores the fundamentals bodies a session's rows point
// at. A hash already stored keeps its row (ON CONFLICT DO NOTHING), so a
// re-fetch with unchanged figures writes nothing here.
func WriteFundamentalsBlobs(ctx context.Context, w Writer, blobs map[string]features.Fundamentals, firstSeen civil.Date) error {
	if len(blobs) == 0 {
		return nil
	}
	hashes := make([]string, 0, len(blobs))
	for h := range blobs {
		hashes = append(hashes, h)
	}
	sort.Strings(hashes)
	batch := &pgx.Batch{}
	for _, h := range hashes {
		batch.Queue(`
			INSERT INTO strategy_fundamentals_blobs (hash, body, first_seen)
			VALUES ($1, $2::jsonb, $3::date)
			ON CONFLICT (hash) DO NOTHING`, h, string(blobs[h].Blob), firstSeen.String())
	}
	if err := sendAll(ctx, w, batch, len(hashes)); err != nil {
		return fmt.Errorf("write fundamentals blobs: %w", err)
	}
	return nil
}

// ReadFeatureRows reads one session's feature rows of a feature set, in code
// order. A missing table is an empty result: the daily job has not run yet.
func ReadFeatureRows(ctx context.Context, db DB, asOf civil.Date, featureSet string) ([]snapshot.Row, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT as_of, feature_set, stock_code, bar_date, ordinary_fresh_60, ineligible_reason,
		       is_ordinary, in_asic_report, short_report_date, short_available_date, short_status,
		       ca_suspect_date, features::text, fundamentals_hash, meta::text
		  FROM strategy_features_daily
		 WHERE as_of = $1::date AND feature_set = $2
		 ORDER BY stock_code`, asOf.String(), featureSet)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadFeatureRows", err)
			return nil, nil
		}
		return nil, fmt.Errorf("query feature rows for %s: %w", asOf, err)
	}
	defer rows.Close()
	var out []snapshot.Row
	for rows.Next() {
		var (
			r                                      snapshot.Row
			asOfT                                  time.Time
			barDate, reportDate, availableDate     *time.Time
			caDate                                 *time.Time
			ineligible, status, fundHash, metaText *string
			featuresText                           string
		)
		if err := rows.Scan(&asOfT, &r.FeatureSet, &r.StockCode, &barDate, &r.OrdinaryFresh60, &ineligible,
			&r.IsOrdinary, &r.InASICReport, &reportDate, &availableDate, &status, &caDate,
			&featuresText, &fundHash, &metaText); err != nil {
			return nil, fmt.Errorf("scan feature row: %w", err)
		}
		r.AsOf = dateOf(asOfT)
		if barDate != nil {
			r.BarDate = dateOf(*barDate)
		}
		r.IneligibleReason = derefString(ineligible)
		r.ShortStatus = derefString(status)
		r.ShortReportDate = optionalDate(reportDate)
		r.ShortAvailableDate = optionalDate(availableDate)
		r.CASuspectDate = optionalDate(caDate)
		r.FundamentalsHash = derefString(fundHash)
		if metaText != nil {
			r.Meta = []byte(*metaText)
		}
		f, err := snapshot.DecodeFeatures([]byte(featuresText))
		if err != nil {
			return nil, fmt.Errorf("feature row %s: %w", r.StockCode, err)
		}
		r.Features = f
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate feature rows: %w", err)
	}
	return out, nil
}

// ReadFundamentalsBlobs reads the blobs the given hashes name. A hash with no
// stored blob is absent from the map, and the caller decides what that means.
func ReadFundamentalsBlobs(ctx context.Context, db DB, hashes []string) (map[string]features.Fundamentals, error) {
	out := map[string]features.Fundamentals{}
	if len(hashes) == 0 {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `SELECT hash, body::text FROM strategy_fundamentals_blobs WHERE hash = ANY($1)`, hashes)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadFundamentalsBlobs", err)
			return out, nil
		}
		return nil, fmt.Errorf("query fundamentals blobs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var hash, body string
		if err := rows.Scan(&hash, &body); err != nil {
			return nil, fmt.Errorf("scan fundamentals blob: %w", err)
		}
		out[hash] = features.Fundamentals{Hash: hash, Blob: []byte(body)}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fundamentals blobs: %w", err)
	}
	return out, nil
}

// WriteRegime upserts one index's regime for a session.
func WriteRegime(ctx context.Context, w Writer, asOf civil.Date, indexCode string, r engine.Regime) error {
	var label any
	if r.Label != "" {
		label = r.Label
	}
	_, err := w.Exec(ctx, `
		INSERT INTO strategy_regime_daily (as_of, index_code, close, sma50, sma200, pct_off_52w_high, ret_1m_pct, ret_3m_pct, regime)
		VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (as_of, index_code) DO UPDATE SET
			close = EXCLUDED.close, sma50 = EXCLUDED.sma50, sma200 = EXCLUDED.sma200,
			pct_off_52w_high = EXCLUDED.pct_off_52w_high, ret_1m_pct = EXCLUDED.ret_1m_pct,
			ret_3m_pct = EXCLUDED.ret_3m_pct, regime = EXCLUDED.regime`,
		asOf.String(), indexCode, floatArg(r.Close), floatArg(r.SMA50), floatArg(r.SMA200),
		floatArg(r.PctOff52wHigh), floatArg(r.Ret1mPct), floatArg(r.Ret3mPct), label)
	if err != nil {
		return fmt.Errorf("write regime for %s: %w", asOf, err)
	}
	return nil
}

// ReadRegime reads one index's regime for a session. ok is false when no row
// exists for the session.
func ReadRegime(ctx context.Context, db DB, asOf civil.Date, indexCode string) (engine.Regime, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	var (
		close, sma50, sma200, pct, r1, r3 *float64
		label                             *string
	)
	err := db.QueryRow(ctx, `
		SELECT close, sma50, sma200, pct_off_52w_high, ret_1m_pct, ret_3m_pct, regime
		  FROM strategy_regime_daily WHERE as_of = $1::date AND index_code = $2`,
		asOf.String(), indexCode).Scan(&close, &sma50, &sma200, &pct, &r1, &r3, &label)
	if err == pgx.ErrNoRows {
		return engine.Regime{}, false, nil
	}
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ReadRegime", err)
			return engine.Regime{}, false, nil
		}
		return engine.Regime{}, false, fmt.Errorf("read regime for %s: %w", asOf, err)
	}
	day := time.Date(asOf.Year, asOf.Month, asOf.Day, 0, 0, 0, 0, time.UTC)
	return engine.Regime{
		IndexCode: indexCode, AsOf: &day, Close: close, SMA50: sma50, SMA200: sma200,
		PctOff52wHigh: pct, Ret1mPct: r1, Ret3mPct: r3, Label: derefString(label),
	}, true, nil
}

func floatArg(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func optionalDate(t *time.Time) *civil.Date {
	if t == nil {
		return nil
	}
	d := dateOf(*t)
	return &d
}
