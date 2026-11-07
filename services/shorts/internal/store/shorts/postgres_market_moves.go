package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5"
)

// Market moves (migration 000160): what the market-moves workflow posts.
//
// A move is keyed by the poster's own move_key. Posting a key again updates the
// row in place and raises its revision, so a workflow that re-reads the market
// every few minutes revises one move rather than adding a new one each time.
// Posting the same content again changes nothing (the content hash matches) and
// is not a revision. A retraction is final: the row stays, with status
// 'retracted', and no reader serves it; posting its key again is refused.
//
// The writer is one transaction that locks the key's row first (SELECT ... FOR
// UPDATE), so two posts of one key run one after the other. Two FIRST posts of
// a new key cannot both lock a row that does not exist yet: the second insert
// finds the conflict and answers ErrMarketMoveBusy, and a retry takes the update
// path. The per-day cap counts the date's rows inside the same transaction; it
// is a guard against a runaway poster, not an exact quota, so two concurrent
// first posts at the cap can both land.

// The errors the writer answers with. The handlers map each to one status.
var (
	// ErrMarketMoveRetracted: the key was retracted, and a retraction is final.
	ErrMarketMoveRetracted = errors.New("market move was retracted")
	// ErrMarketMoveSubjectChanged: a re-post named a different kind, stock,
	// index or sector than the move it revises.
	ErrMarketMoveSubjectChanged = errors.New("market move subject cannot change")
	// ErrMarketMoveDailyCap: the market date already holds MaxPerDay moves.
	ErrMarketMoveDailyCap = errors.New("market move daily cap reached")
	// ErrMarketMoveRevisionCap: the move already has MaxRevisions revisions.
	ErrMarketMoveRevisionCap = errors.New("market move revision cap reached")
	// ErrMarketMoveBusy: another post of the same new key landed first. Nothing
	// was written; a retry is safe and takes the update path.
	ErrMarketMoveBusy = errors.New("market move is being posted concurrently")
	// ErrMarketMoveNotFound: no move holds the key.
	ErrMarketMoveNotFound = errors.New("market move not found")
)

// Outcomes of an upsert.
const (
	MarketMoveCreated   = "created"
	MarketMoveUpdated   = "updated"
	MarketMoveUnchanged = "unchanged"
)

// Statuses of a move.
const (
	MarketMovePublished = "published"
	MarketMoveRetracted = "retracted"
)

// marketMovesMissingOnce logs one warning when the table is absent.
var marketMovesMissingOnce sync.Once

// The Postgres store is the market-moves store.
var _ MarketMovesStore = (*postgresStore)(nil)

// MarketMoveSource is one cited source, stored in the sources JSONB array.
type MarketMoveSource struct {
	Title     string `json:"title"`
	URL       string `json:"url"`
	Publisher string `json:"publisher,omitempty"`
}

// MarketMoveRecord is one move as stored. The writer fills the posted fields
// (MoveKey through RunID, plus ContentHash and Actor); the store fills the rest.
type MarketMoveRecord struct {
	ID           int64
	MoveKey      string
	Kind         string
	StockCode    string
	CompanyName  string // read only: company-metadata's name for StockCode
	IndexCode    string
	Sector       string
	RelatedCodes []string
	Direction    string
	ChangePct    *float64
	Price        *float64
	VolumeRatio  *float64
	Headline     string
	Summary      string
	Sources      []MarketMoveSource
	Tags         []string
	Significance int
	ObservedAt   time.Time
	MarketDate   string // YYYY-MM-DD, Sydney
	Model        string
	RunID        string
	ContentHash  string
	Actor        string

	Status        string
	Revision      int
	RetractedAt   *time.Time
	RetractReason string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// MarketMoveLimits bound one poster. Zero means the default.
type MarketMoveLimits struct {
	MaxPerDay    int
	MaxRevisions int
}

// Default limits: a workflow that posts every few minutes all day stays well
// under both, and a runaway one stops within a day's worth of rows.
const (
	DefaultMarketMovesPerDay      = 300
	DefaultMarketMoveMaxRevisions = 100
)

func (l MarketMoveLimits) perDay() int {
	if l.MaxPerDay <= 0 {
		return DefaultMarketMovesPerDay
	}
	return l.MaxPerDay
}

func (l MarketMoveLimits) revisions() int {
	if l.MaxRevisions <= 0 {
		return DefaultMarketMoveMaxRevisions
	}
	return l.MaxRevisions
}

// MarketMoveUpsertResult is the move as it stands after a post, and what the
// post did to it.
type MarketMoveUpsertResult struct {
	Move    MarketMoveRecord
	Outcome string // created | updated | unchanged
}

// MarketMovesFilter selects published moves, newest observation first.
type MarketMovesFilter struct {
	StockCode       string // primary or related
	Kind            string
	MarketDate      string // YYYY-MM-DD
	MinSignificance int
	// Limit is the number of rows to read (the caller asks for one more than it
	// serves to learn whether a next page exists).
	Limit int
	// The keyset cursor: rows strictly older than (BeforeObservedAt, BeforeID).
	BeforeObservedAt *time.Time
	BeforeID         int64
}

// MarketMovesStore is the part of the store the market-moves writer and reader
// use. The Postgres store implements it; a store without it leaves the writer
// unavailable and the reader empty.
type MarketMovesStore interface {
	// UpsertMarketMove posts a move: created for a new key, updated when the
	// content changed, unchanged when it did not.
	UpsertMarketMove(ctx context.Context, rec MarketMoveRecord, limits MarketMoveLimits) (MarketMoveUpsertResult, error)
	// RetractMarketMove retracts the key's move. Retracting a retracted move
	// returns it as it is. ErrMarketMoveNotFound for an unknown key.
	RetractMarketMove(ctx context.Context, moveKey, reason, actor string) (MarketMoveRecord, error)
	// ListMarketMoves reads published moves. A database without the table
	// answers an empty list.
	ListMarketMoves(ctx context.Context, f MarketMovesFilter) ([]MarketMoveRecord, error)
	// KnownStockCodes reports which of codes we hold: a company-metadata row or
	// a stock price. Codes are compared as given (upper case).
	KnownStockCodes(ctx context.Context, codes []string) (map[string]bool, error)
}

// marketMoveColumns is the select list every read uses, in scanMarketMove's order.
const marketMoveColumns = `
	mm.id, mm.move_key, mm.kind, COALESCE(mm.stock_code, ''), COALESCE(m.company_name, ''),
	COALESCE(mm.index_code, ''), COALESCE(mm.sector, ''), mm.related_codes, mm.direction,
	mm.change_pct::float8, mm.price::float8, mm.volume_ratio::float8,
	mm.headline, mm.summary, mm.sources, mm.tags, mm.significance, mm.observed_at,
	to_char(mm.market_date, 'YYYY-MM-DD'), COALESCE(mm.model, ''), COALESCE(mm.run_id, ''),
	mm.content_hash, mm.actor, mm.status, mm.revision, mm.retracted_at,
	COALESCE(mm.retract_reason, ''), mm.created_at, mm.updated_at`

const marketMoveFrom = `
	FROM market_moves mm
	LEFT JOIN "company-metadata" m ON m.stock_code = mm.stock_code`

func scanMarketMove(row pgx.Row) (MarketMoveRecord, error) {
	var r MarketMoveRecord
	var sources []byte
	var significance int16
	if err := row.Scan(
		&r.ID, &r.MoveKey, &r.Kind, &r.StockCode, &r.CompanyName,
		&r.IndexCode, &r.Sector, &r.RelatedCodes, &r.Direction,
		&r.ChangePct, &r.Price, &r.VolumeRatio,
		&r.Headline, &r.Summary, &sources, &r.Tags, &significance, &r.ObservedAt,
		&r.MarketDate, &r.Model, &r.RunID,
		&r.ContentHash, &r.Actor, &r.Status, &r.Revision, &r.RetractedAt,
		&r.RetractReason, &r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		return MarketMoveRecord{}, err
	}
	r.Significance = int(significance)
	r.CompanyName = cleanCompanyName(r.CompanyName, r.StockCode)
	if len(sources) > 0 {
		if err := json.Unmarshal(sources, &r.Sources); err != nil {
			return MarketMoveRecord{}, fmt.Errorf("decode market move sources: %w", err)
		}
	}
	if r.RelatedCodes == nil {
		r.RelatedCodes = []string{}
	}
	if r.Tags == nil {
		r.Tags = []string{}
	}
	return r, nil
}

// nullIfEmpty stores "" as NULL, so an absent code or sector is NULL in the row.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// UpsertMarketMove posts one move inside one transaction.
func (s *postgresStore) UpsertMarketMove(ctx context.Context, rec MarketMoveRecord, limits MarketMoveLimits) (MarketMoveUpsertResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	sources, err := json.Marshal(nonNilSources(rec.Sources))
	if err != nil {
		return MarketMoveUpsertResult{}, fmt.Errorf("encode market move sources: %w", err)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return MarketMoveUpsertResult{}, fmt.Errorf("begin market move post: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		existingID                                      int64
		kind, stockCode, indexCode, sector, status, hash string
		revision                                        int
	)
	err = tx.QueryRow(ctx, `
		SELECT id, kind, COALESCE(stock_code, ''), COALESCE(index_code, ''), COALESCE(sector, ''),
		       status, revision, content_hash
		FROM market_moves WHERE move_key = $1::text FOR UPDATE`,
		rec.MoveKey,
	).Scan(&existingID, &kind, &stockCode, &indexCode, &sector, &status, &revision, &hash)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		var count int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM market_moves WHERE market_date = $1::date`, rec.MarketDate,
		).Scan(&count); err != nil {
			return MarketMoveUpsertResult{}, fmt.Errorf("count market moves: %w", relationMissing(err))
		}
		if count >= limits.perDay() {
			return MarketMoveUpsertResult{}, fmt.Errorf("%w: %d moves already posted for %s", ErrMarketMoveDailyCap, count, rec.MarketDate)
		}
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO market_moves (
				move_key, kind, stock_code, index_code, sector, related_codes, direction,
				change_pct, price, volume_ratio, headline, summary, sources, tags, significance,
				observed_at, market_date, content_hash, actor, model, run_id
			) VALUES (
				$1, $2, $3, $4, $5, $6::text[], $7,
				$8::float8::numeric, $9::float8::numeric, $10::float8::numeric, $11, $12, $13::jsonb, $14::text[], $15::smallint,
				$16, $17::date, $18, $19, $20, $21
			)
			ON CONFLICT (move_key) DO NOTHING
			RETURNING id`,
			rec.MoveKey, rec.Kind, nullIfEmpty(rec.StockCode), nullIfEmpty(rec.IndexCode), nullIfEmpty(rec.Sector),
			nonNilStrings(rec.RelatedCodes), rec.Direction,
			rec.ChangePct, rec.Price, rec.VolumeRatio, rec.Headline, rec.Summary, string(sources),
			nonNilStrings(rec.Tags), rec.Significance,
			rec.ObservedAt, rec.MarketDate, rec.ContentHash, rec.Actor, nullIfEmpty(rec.Model), nullIfEmpty(rec.RunID),
		).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return MarketMoveUpsertResult{}, ErrMarketMoveBusy
		}
		if err != nil {
			return MarketMoveUpsertResult{}, fmt.Errorf("insert market move: %w", relationMissing(err))
		}
		return s.commitMarketMove(ctx, tx, id, MarketMoveCreated)

	case err != nil:
		return MarketMoveUpsertResult{}, fmt.Errorf("lock market move: %w", relationMissing(err))
	}

	if status == MarketMoveRetracted {
		return MarketMoveUpsertResult{}, fmt.Errorf("%w: %s", ErrMarketMoveRetracted, rec.MoveKey)
	}
	if kind != rec.Kind || stockCode != rec.StockCode || indexCode != rec.IndexCode || sector != rec.Sector {
		return MarketMoveUpsertResult{}, fmt.Errorf("%w: %s is a %s move about %s; post a new key for a different subject",
			ErrMarketMoveSubjectChanged, rec.MoveKey, kind, firstNonEmpty(stockCode, indexCode, sector, "the market"))
	}
	if hash == rec.ContentHash {
		return s.commitMarketMove(ctx, tx, existingID, MarketMoveUnchanged)
	}
	if revision >= limits.revisions() {
		return MarketMoveUpsertResult{}, fmt.Errorf("%w: %s has %d revisions", ErrMarketMoveRevisionCap, rec.MoveKey, revision)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE market_moves SET
			related_codes = $2::text[], direction = $3,
			change_pct = $4::float8::numeric, price = $5::float8::numeric, volume_ratio = $6::float8::numeric,
			headline = $7, summary = $8, sources = $9::jsonb, tags = $10::text[], significance = $11::smallint,
			observed_at = $12, market_date = $13::date, content_hash = $14, actor = $15, model = $16, run_id = $17,
			revision = revision + 1, updated_at = now()
		WHERE id = $1`,
		existingID, nonNilStrings(rec.RelatedCodes), rec.Direction,
		rec.ChangePct, rec.Price, rec.VolumeRatio,
		rec.Headline, rec.Summary, string(sources), nonNilStrings(rec.Tags), rec.Significance,
		rec.ObservedAt, rec.MarketDate, rec.ContentHash, rec.Actor, nullIfEmpty(rec.Model), nullIfEmpty(rec.RunID),
	); err != nil {
		return MarketMoveUpsertResult{}, fmt.Errorf("update market move: %w", err)
	}
	return s.commitMarketMove(ctx, tx, existingID, MarketMoveUpdated)
}

// commitMarketMove reads the row back inside the transaction, then commits.
func (s *postgresStore) commitMarketMove(ctx context.Context, tx pgx.Tx, id int64, outcome string) (MarketMoveUpsertResult, error) {
	move, err := scanMarketMove(tx.QueryRow(ctx, `SELECT `+marketMoveColumns+marketMoveFrom+` WHERE mm.id = $1`, id))
	if err != nil {
		return MarketMoveUpsertResult{}, fmt.Errorf("read market move: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MarketMoveUpsertResult{}, fmt.Errorf("commit market move: %w", err)
	}
	return MarketMoveUpsertResult{Move: move, Outcome: outcome}, nil
}

// RetractMarketMove sets the key's move to retracted. It is idempotent: a move
// already retracted keeps its first retraction's time and reason.
func (s *postgresStore) RetractMarketMove(ctx context.Context, moveKey, reason, actor string) (MarketMoveRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := s.db.Exec(ctx, `
		UPDATE market_moves SET
			status = 'retracted', retracted_at = now(), retract_reason = $2, actor = $3, updated_at = now()
		WHERE move_key = $1::text AND status = 'published'`,
		moveKey, nullIfEmpty(reason), actor,
	)
	if err != nil {
		return MarketMoveRecord{}, fmt.Errorf("retract market move: %w", relationMissing(err))
	}
	move, err := scanMarketMove(s.db.QueryRow(ctx, `SELECT `+marketMoveColumns+marketMoveFrom+` WHERE mm.move_key = $1::text`, moveKey))
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketMoveRecord{}, fmt.Errorf("%w: %s", ErrMarketMoveNotFound, moveKey)
	}
	if err != nil {
		return MarketMoveRecord{}, fmt.Errorf("read retracted market move: %w", relationMissing(err))
	}
	return move, nil
}

// ListMarketMoves reads published moves, newest observation first.
func (s *postgresStore) ListMarketMoves(ctx context.Context, f MarketMovesFilter) ([]MarketMoveRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	where := []string{"mm.status = 'published'"}
	args := []any{}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if f.StockCode != "" {
		p := arg(f.StockCode)
		where = append(where, fmt.Sprintf("(mm.stock_code = %s::text OR %s::text = ANY (mm.related_codes))", p, p))
	}
	if f.Kind != "" {
		where = append(where, "mm.kind = "+arg(f.Kind)+"::text")
	}
	if f.MarketDate != "" {
		where = append(where, "mm.market_date = "+arg(f.MarketDate)+"::date")
	}
	if f.MinSignificance > 0 {
		where = append(where, "mm.significance >= "+arg(f.MinSignificance)+"::smallint")
	}
	if f.BeforeObservedAt != nil {
		where = append(where, fmt.Sprintf("(mm.observed_at, mm.id) < (%s::timestamptz, %s::bigint)", arg(*f.BeforeObservedAt), arg(f.BeforeID)))
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 20
	}
	query := `SELECT ` + marketMoveColumns + marketMoveFrom +
		` WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY mm.observed_at DESC, mm.id DESC LIMIT ` + arg(limit)

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		if errors.Is(relationMissing(err), ErrRelationMissing) {
			marketMovesMissingOnce.Do(func() {
				log.Warnf("ListMarketMoves: market_moves is missing (migration 000160 not applied?); serving an empty list: %v", err)
			})
			return []MarketMoveRecord{}, nil
		}
		return nil, fmt.Errorf("list market moves: %w", err)
	}
	defer rows.Close()

	out := []MarketMoveRecord{}
	for rows.Next() {
		r, err := scanMarketMove(rows)
		if err != nil {
			return nil, fmt.Errorf("scan market move: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read market moves: %w", err)
	}
	return out, nil
}

// KnownStockCodes reports which codes we hold.
func (s *postgresStore) KnownStockCodes(ctx context.Context, codes []string) (map[string]bool, error) {
	known := make(map[string]bool, len(codes))
	if len(codes) == 0 {
		return known, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT c.code
		FROM unnest($1::text[]) AS c(code)
		WHERE EXISTS (SELECT 1 FROM "company-metadata" m WHERE m.stock_code = c.code)
		   OR EXISTS (SELECT 1 FROM stock_prices p WHERE p.stock_code = c.code)`,
		codes,
	)
	if err != nil {
		return nil, fmt.Errorf("check stock codes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, fmt.Errorf("scan stock code: %w", err)
		}
		known[code] = true
	}
	return known, rows.Err()
}

func nonNilStrings(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func nonNilSources(v []MarketMoveSource) []MarketMoveSource {
	if v == nil {
		return []MarketMoveSource{}
	}
	return v
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
