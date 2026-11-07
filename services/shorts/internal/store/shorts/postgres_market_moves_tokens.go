package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Market-moves tokens (migration 000160): the credentials a market-moves
// workflow posts with. An administrator creates and revokes them in the admin
// console; the store holds only each token's SHA-256 and a short prefix, so a
// token cannot be read back once its creation response has gone.

// MaxActiveMarketMovesTokens bounds the tokens alive at once. A workflow needs
// one; a few more cover a rotation and a second workflow.
const MaxActiveMarketMovesTokens = 10

var (
	// ErrMarketMovesTokenCap: MaxActiveMarketMovesTokens are already active.
	ErrMarketMovesTokenCap = errors.New("market moves token cap reached")
	// ErrMarketMovesTokenNotFound: no token has the id.
	ErrMarketMovesTokenNotFound = errors.New("market moves token not found")
)

// The Postgres store is the token store.
var _ MarketMovesTokenStore = (*postgresStore)(nil)

// MarketMovesTokenRow is one token as stored. It never carries the token.
type MarketMovesTokenRow struct {
	ID         int64
	Name       string
	Prefix     string
	Hash       string
	CreatedBy  string
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
	RevokedBy  string
}

// Usable reports whether the token may post at now.
func (r MarketMovesTokenRow) Usable(now time.Time) bool {
	return r.RevokedAt == nil && (r.ExpiresAt == nil || now.Before(*r.ExpiresAt))
}

// MarketMovesTokenStore is the part of the store the token console and the
// posting door use.
type MarketMovesTokenStore interface {
	// CreateMarketMovesToken stores a new token's hash. ErrMarketMovesTokenCap
	// when MaxActiveMarketMovesTokens tokens are already usable.
	CreateMarketMovesToken(ctx context.Context, name, hash, prefix, createdBy string, expiresAt *time.Time) (MarketMovesTokenRow, error)
	// ListMarketMovesTokens returns every token, active first, newest first.
	ListMarketMovesTokens(ctx context.Context) ([]MarketMovesTokenRow, error)
	// RevokeMarketMovesToken revokes one token. Revoking a revoked token keeps
	// its first revocation. ErrMarketMovesTokenNotFound for an unknown id.
	RevokeMarketMovesToken(ctx context.Context, id int64, revokedBy string) (MarketMovesTokenRow, error)
	// MarketMovesTokenByHash finds a token by its hash; found is false for none.
	MarketMovesTokenByHash(ctx context.Context, hash string) (row MarketMovesTokenRow, found bool, err error)
	// TouchMarketMovesToken records a use, at most once a minute per token.
	TouchMarketMovesToken(ctx context.Context, id int64) error
}

const marketMovesTokenColumns = `id, name, token_prefix, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at, COALESCE(revoked_by, '')`

func scanMarketMovesToken(row pgx.Row) (MarketMovesTokenRow, error) {
	var r MarketMovesTokenRow
	err := row.Scan(&r.ID, &r.Name, &r.Prefix, &r.Hash, &r.CreatedBy, &r.CreatedAt, &r.ExpiresAt, &r.LastUsedAt, &r.RevokedAt, &r.RevokedBy)
	return r, err
}

// CreateMarketMovesToken inserts the token under an advisory lock, so the cap
// is exact when two administrators create tokens at the same moment.
func (s *postgresStore) CreateMarketMovesToken(ctx context.Context, name, hash, prefix, createdBy string, expiresAt *time.Time) (MarketMovesTokenRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("begin market moves token create: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('market_moves_tokens'))`); err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("lock market moves tokens: %w", err)
	}
	var active int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM market_moves_tokens
		WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
	).Scan(&active); err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("count market moves tokens: %w", relationMissing(err))
	}
	if active >= MaxActiveMarketMovesTokens {
		return MarketMovesTokenRow{}, fmt.Errorf("%w: %d tokens are active; revoke one first", ErrMarketMovesTokenCap, active)
	}
	row, err := scanMarketMovesToken(tx.QueryRow(ctx, `
		INSERT INTO market_moves_tokens (name, token_hash, token_prefix, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING `+marketMovesTokenColumns,
		name, hash, prefix, createdBy, expiresAt,
	))
	if err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("insert market moves token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("commit market moves token: %w", err)
	}
	return row, nil
}

// ListMarketMovesTokens returns the newest 100 tokens, the usable ones first.
func (s *postgresStore) ListMarketMovesTokens(ctx context.Context) ([]MarketMovesTokenRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT `+marketMovesTokenColumns+`
		FROM market_moves_tokens
		ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) DESC, created_at DESC, id DESC
		LIMIT 100`)
	if err != nil {
		return nil, fmt.Errorf("list market moves tokens: %w", relationMissing(err))
	}
	defer rows.Close()
	out := []MarketMovesTokenRow{}
	for rows.Next() {
		r, err := scanMarketMovesToken(rows)
		if err != nil {
			return nil, fmt.Errorf("scan market moves token: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RevokeMarketMovesToken revokes the token, idempotently.
func (s *postgresStore) RevokeMarketMovesToken(ctx context.Context, id int64, revokedBy string) (MarketMovesTokenRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	row, err := scanMarketMovesToken(s.db.QueryRow(ctx, `
		UPDATE market_moves_tokens
		SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $2)
		WHERE id = $1
		RETURNING `+marketMovesTokenColumns,
		id, revokedBy,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketMovesTokenRow{}, fmt.Errorf("%w: %d", ErrMarketMovesTokenNotFound, id)
	}
	if err != nil {
		return MarketMovesTokenRow{}, fmt.Errorf("revoke market moves token: %w", relationMissing(err))
	}
	return row, nil
}

// MarketMovesTokenByHash finds a token by its hash.
func (s *postgresStore) MarketMovesTokenByHash(ctx context.Context, hash string) (MarketMovesTokenRow, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	row, err := scanMarketMovesToken(s.db.QueryRow(ctx,
		`SELECT `+marketMovesTokenColumns+` FROM market_moves_tokens WHERE token_hash = $1`, hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketMovesTokenRow{}, false, nil
	}
	if err != nil {
		return MarketMovesTokenRow{}, false, fmt.Errorf("look up market moves token: %w", relationMissing(err))
	}
	return row, true, nil
}

// TouchMarketMovesToken records a use. The WHERE clause keeps a busy workflow
// from writing the row on every post.
func (s *postgresStore) TouchMarketMovesToken(ctx context.Context, id int64) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, err := s.db.Exec(ctx, `
		UPDATE market_moves_tokens SET last_used_at = now()
		WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, id)
	if err != nil {
		return fmt.Errorf("touch market moves token: %w", err)
	}
	return nil
}
