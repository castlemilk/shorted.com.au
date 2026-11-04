package shorts

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Index fund flow read path (migration 000137; spec 14.10).
//
// The fund files accumulate: fund_holding_snapshots keeps one row per
// (institution, fund, as_at), so the history of what each index fund and super
// option held is on record. These reads select files by id, so a window reads
// only the files at its edges, never the whole history. A database without the
// ownership tables reads as no rows, never an error.

// OwnershipFundFlowStore is the index fund flow read surface. It is a separate
// interface from OwnershipStore, found by type assertion, so a store without it
// serves no fund figures and OwnershipStore's implementers are not touched.
type OwnershipFundFlowStore interface {
	FundSnapshots(ctx context.Context) ([]FundSnapshotRow, error)
	FundSnapshotHoldings(ctx context.Context, snapshotIDs []int64, stockCode string) ([]FundSnapshotHoldingRow, error)
	FundHoldingChanges(ctx context.Context, pairs []FundSnapshotPair, stockCodes []string) ([]FundHoldingChangeRow, error)
}

var _ OwnershipFundFlowStore = (*postgresStore)(nil)

// FundSnapshotRow is one fund file: who published it, for which fund, and the
// date it is as at.
type FundSnapshotRow struct {
	ID                                                    int64
	InstitutionSlug, FundName, FundCode, SourceKind, AsAt string
}

// FundSnapshotHoldingRow is one stock in one file. Units and Value are nil when
// the file does not state them.
type FundSnapshotHoldingRow struct {
	SnapshotID   int64
	StockCode    string
	Units, Value *float64
}

// FundSnapshotPair compares two files of one fund: From is the earlier, To the
// later. Group gathers pairs whose changes are summed together (a bucket, a
// window, an institution); the caller numbers the groups.
type FundSnapshotPair struct {
	Group    int32
	From, To int64
}

// FundHoldingChangeRow is one stock's change across a group of pairs. Units are
// summed over the rows that state units. A price is priced value over priced
// units: PricedUnitsFrom/To sum the units, and UnitValueFrom/To the value, of
// only the rows that state both, so a row with units and no value never dilutes
// a price or adds shares to it at zero. ValueOnlyFrom/To sum the value of rows
// that state no units (some files state only a value). RowFrom/RowTo say the
// side's file holds a row for the stock at all: a row with no units on a side is
// a figure the file does not state, never a holding of none.
type FundHoldingChangeRow struct {
	Group                          int32
	StockCode                      string
	UnitsFrom, UnitsTo             float64
	PricedUnitsFrom, PricedUnitsTo float64
	UnitValueFrom, UnitValueTo     float64
	ValueOnlyFrom, ValueOnlyTo     float64
	HasUnitsFrom, HasUnitsTo       bool
	RowFrom, RowTo                 bool
}

// FundSnapshots is every fund file, oldest first. One row per file, a few
// thousand at most, read once per universe generation.
func (s *postgresStore) FundSnapshots(ctx context.Context) ([]FundSnapshotRow, error) {
	var out []FundSnapshotRow
	err := ownershipRead(ctx, s, "FundSnapshots", `
		SELECT s.id, s.institution_slug, s.fund_name, COALESCE(s.fund_code, ''), s.source_kind, s.as_at::text
		FROM fund_holding_snapshots s
		ORDER BY s.as_at, s.id`, nil,
		func(r pgx.Rows) error {
			var row FundSnapshotRow
			if err := r.Scan(&row.ID, &row.InstitutionSlug, &row.FundName, &row.FundCode, &row.SourceKind, &row.AsAt); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// FundSnapshotHoldings is every stock in the named files, or one stock when
// stockCode is set. The primary key (snapshot_id, stock_code) serves both.
func (s *postgresStore) FundSnapshotHoldings(ctx context.Context, snapshotIDs []int64, stockCode string) ([]FundSnapshotHoldingRow, error) {
	if len(snapshotIDs) == 0 {
		return nil, nil
	}
	query := `
		SELECT h.snapshot_id, h.stock_code, h.units::float8, h.value_aud::float8
		FROM fund_holdings h
		WHERE h.snapshot_id = ANY($1::bigint[])`
	args := []any{snapshotIDs}
	if stockCode != "" {
		query += ` AND h.stock_code = $2`
		args = append(args, stockCode)
	}
	var out []FundSnapshotHoldingRow
	err := ownershipRead(ctx, s, "FundSnapshotHoldings", query, args,
		func(r pgx.Rows) error {
			var row FundSnapshotHoldingRow
			if err := r.Scan(&row.SnapshotID, &row.StockCode, &row.Units, &row.Value); err != nil {
				return err
			}
			out = append(out, row)
			return nil
		})
	return out, err
}

// FundHoldingChanges sums, per group and stock, what each pair's two files hold:
// a stock in the later file only is a new position, in the earlier only a
// position gone. The aggregate runs in the database, so a heatmap of many
// buckets returns one row per bucket and stock rather than every file's rows.
// stockCodes, when non-empty, limits the stocks read.
func (s *postgresStore) FundHoldingChanges(ctx context.Context, pairs []FundSnapshotPair, stockCodes []string) ([]FundHoldingChangeRow, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	groups := make([]int32, len(pairs))
	froms := make([]int64, len(pairs))
	tos := make([]int64, len(pairs))
	for i, p := range pairs {
		groups[i], froms[i], tos[i] = p.Group, p.From, p.To
	}
	args := []any{groups, froms, tos}
	stockClause := ""
	if len(stockCodes) > 0 {
		args = append(args, stockCodes)
		stockClause = ` AND h.stock_code = ANY($4::text[])`
	}
	var out []FundHoldingChangeRow
	err := ownershipRead(ctx, s, "FundHoldingChanges", `
		WITH pairs AS (
			SELECT * FROM unnest($1::int[], $2::bigint[], $3::bigint[]) AS p(grp, a, b)
		)
		SELECT p.grp, h.stock_code,
		       COALESCE(sum(h.units) FILTER (WHERE h.snapshot_id = p.a AND h.units IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.units) FILTER (WHERE h.snapshot_id = p.b AND h.units IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.units) FILTER (WHERE h.snapshot_id = p.a AND h.units IS NOT NULL AND h.value_aud IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.units) FILTER (WHERE h.snapshot_id = p.b AND h.units IS NOT NULL AND h.value_aud IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.value_aud) FILTER (WHERE h.snapshot_id = p.a AND h.units IS NOT NULL AND h.value_aud IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.value_aud) FILTER (WHERE h.snapshot_id = p.b AND h.units IS NOT NULL AND h.value_aud IS NOT NULL), 0)::float8,
		       COALESCE(sum(h.value_aud) FILTER (WHERE h.snapshot_id = p.a AND h.units IS NULL), 0)::float8,
		       COALESCE(sum(h.value_aud) FILTER (WHERE h.snapshot_id = p.b AND h.units IS NULL), 0)::float8,
		       bool_or(h.snapshot_id = p.a AND h.units IS NOT NULL),
		       bool_or(h.snapshot_id = p.b AND h.units IS NOT NULL),
		       bool_or(h.snapshot_id = p.a),
		       bool_or(h.snapshot_id = p.b)
		FROM pairs p
		JOIN fund_holdings h ON h.snapshot_id IN (p.a, p.b)
		WHERE true`+stockClause+`
		GROUP BY p.grp, h.stock_code`, args,
		func(r pgx.Rows) error {
			var row FundHoldingChangeRow
			var hasFrom, hasTo, rowFrom, rowTo *bool
			if err := r.Scan(&row.Group, &row.StockCode, &row.UnitsFrom, &row.UnitsTo,
				&row.PricedUnitsFrom, &row.PricedUnitsTo, &row.UnitValueFrom, &row.UnitValueTo,
				&row.ValueOnlyFrom, &row.ValueOnlyTo, &hasFrom, &hasTo, &rowFrom, &rowTo); err != nil {
				return err
			}
			row.HasUnitsFrom = hasFrom != nil && *hasFrom
			row.HasUnitsTo = hasTo != nil && *hasTo
			row.RowFrom = rowFrom != nil && *rowFrom
			row.RowTo = rowTo != nil && *rowTo
			out = append(out, row)
			return nil
		})
	return out, err
}
