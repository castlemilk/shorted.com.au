package oauth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore is the migration-000116 implementation of Store.
//
// It reuses the pool the API already holds rather than opening its own —
// Supabase max_connections is shared across every service, and an OAuth store
// with its own pool would be a second capacity problem for a table that is read
// once per authorization.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore returns nil when there is no pool, so a caller can wire the
// grant handler unconditionally and have it report "unavailable" rather than
// panic on a deployment without Postgres.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	if pool == nil {
		return nil
	}
	return &PostgresStore{pool: pool}
}

// GetClient returns (nil, nil) for an unregistered client.
func (s *PostgresStore) GetClient(ctx context.Context, clientID string) (*Client, error) {
	const q = `
		SELECT client_id, COALESCE(client_name, ''), redirect_uris, grant_types, COALESCE(scope, '')
		FROM oauth_clients
		WHERE client_id = $1`

	var c Client
	err := s.pool.QueryRow(ctx, q, clientID).Scan(
		&c.ClientID, &c.ClientName, &c.RedirectURIs, &c.GrantTypes, &c.Scope,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("loading oauth client: %w", err)
	}
	return &c, nil
}

// CreateAuthorizationCode writes the hashed code.
//
// consumed_at is left NULL on purpose: redemption is the token endpoint's, and
// it consumes with a conditional UPDATE ... WHERE consumed_at IS NULL so two
// concurrent replays contend on the row and exactly one wins.
func (s *PostgresStore) CreateAuthorizationCode(ctx context.Context, code AuthorizationCode) error {
	const q = `
		INSERT INTO oauth_authorization_codes (
			code_hash, client_id, user_id, redirect_uri,
			code_challenge, code_challenge_method, resource, scope, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

	_, err := s.pool.Exec(ctx, q,
		code.CodeHash, code.ClientID, code.UserID, code.RedirectURI,
		code.CodeChallenge, code.CodeChallengeMethod, code.Resource, code.Scope, code.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("storing authorization code: %w", err)
	}
	return nil
}
