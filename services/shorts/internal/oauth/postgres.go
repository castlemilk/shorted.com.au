package oauth

import (
	"context"
	"errors"
	"fmt"
	"time"

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

// The token endpoint's guarantees are SQL guarantees, so the store that
// provides them is asserted here rather than discovered at wiring time.
var (
	_ TokenStore  = (*PostgresStore)(nil)
	_ ClientStore = (*PostgresStore)(nil)
)

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

// SaveClient inserts a registration, or refreshes a CIMD client's cached
// metadata.
//
// The DO UPDATE is guarded so that ONE SOURCE CANNOT OVERWRITE THE OTHER. A
// CIMD client_id is a URL an unauthenticated caller supplies; without the
// guard, pointing us at a document whose client_id happened to collide with a
// DCR-registered id would let that document rewrite the victim's redirect URIs.
// The predicate makes the update apply only when the stored row and the
// incoming row are both 'cimd', so the worst case is a refusal.
//
// RowsAffected() == 0 therefore means "this client_id exists and belongs to the
// other registration path", which is an error rather than a silent no-op.
func (s *PostgresStore) SaveClient(ctx context.Context, reg ClientRegistration) error {
	issuedAt := reg.IssuedAt
	if issuedAt.IsZero() {
		issuedAt = time.Now()
	}
	const q = `
		INSERT INTO oauth_clients (
			client_id, client_id_issued_at, client_name, redirect_uris,
			grant_types, scope, client_uri, registration_source
		) VALUES ($1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8)
		ON CONFLICT (client_id) DO UPDATE
		SET client_name   = EXCLUDED.client_name,
		    redirect_uris = EXCLUDED.redirect_uris,
		    grant_types   = EXCLUDED.grant_types,
		    scope         = EXCLUDED.scope,
		    client_uri    = EXCLUDED.client_uri
		WHERE oauth_clients.registration_source = 'cimd'
		  AND EXCLUDED.registration_source = 'cimd'`

	tag, err := s.pool.Exec(ctx, q,
		reg.ClientID, issuedAt, reg.ClientName, reg.RedirectURIs,
		reg.GrantTypes, reg.Scope, reg.ClientURI, reg.Source,
	)
	if err != nil {
		return fmt.Errorf("saving oauth client: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("oauth client %q is already registered by another registration source", reg.ClientID)
	}
	return nil
}

// TouchClient records that a client was used, which is what keeps the
// unused-client sweep from deleting a client that is still in service.
func (s *PostgresStore) TouchClient(ctx context.Context, clientID string) error {
	const q = `UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`
	if _, err := s.pool.Exec(ctx, q, clientID); err != nil {
		return fmt.Errorf("touching oauth client: %w", err)
	}
	return nil
}

// DeleteUnusedClients removes clients that have been idle since before the
// cutoff AND hold nothing live.
//
// The two NOT EXISTS clauses are the safety property, not an optimisation. The
// child tables reference oauth_clients ON DELETE CASCADE, so a delete here is a
// cascading revocation of every code and refresh token the client holds. Idle
// time alone is not enough evidence: last_used_at is written on client lookup,
// and the refresh grant does not look a client up, so a client refreshing
// happily for months could otherwise look untouched. Asking the token table
// directly is the check that cannot drift.
func (s *PostgresStore) DeleteUnusedClients(ctx context.Context, idleBefore time.Time) (int64, error) {
	const q = `
		DELETE FROM oauth_clients c
		WHERE COALESCE(c.last_used_at, c.client_id_issued_at) < $1
		  AND NOT EXISTS (
		      SELECT 1 FROM oauth_refresh_tokens t
		      WHERE t.client_id = c.client_id
		        AND t.revoked_at IS NULL
		        AND t.rotated_at IS NULL
		        AND t.expires_at > now()
		  )
		  AND NOT EXISTS (
		      SELECT 1 FROM oauth_authorization_codes a
		      WHERE a.client_id = c.client_id
		        AND a.consumed_at IS NULL
		        AND a.expires_at > now()
		  )`

	tag, err := s.pool.Exec(ctx, q, idleBefore)
	if err != nil {
		return 0, fmt.Errorf("deleting unused oauth clients: %w", err)
	}
	return tag.RowsAffected(), nil
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

// ConsumeAuthorizationCode redeems a code in ONE statement.
//
// This is the whole single-use guarantee, and it is why it is not a SELECT
// followed by an UPDATE. The predicate `consumed_at IS NULL` is evaluated
// inside the same statement that writes `consumed_at`, so two concurrent
// presentations of the same code contend on the same row: the first takes the
// row lock and updates it, the second blocks, re-evaluates the predicate under
// READ COMMITTED after the first commits, finds it false, and matches nothing.
// Exactly one caller can ever see a row come back.
//
// A read-then-write would let both callers pass the check before either wrote,
// and a replayed code would be redeemed twice.
//
// Expiry is deliberately NOT in the predicate. An expired code is refused by
// the caller a moment later; keeping it out of the WHERE clause means "already
// used" and "expired" stay distinguishable in the logs, while the property that
// actually matters — at most one redemption — is unaffected.
func (s *PostgresStore) ConsumeAuthorizationCode(ctx context.Context, codeHash string) (*AuthorizationCode, error) {
	const q = `
		UPDATE oauth_authorization_codes
		SET consumed_at = now()
		WHERE code_hash = $1 AND consumed_at IS NULL
		RETURNING code_hash, client_id, user_id, redirect_uri,
		          code_challenge, code_challenge_method, resource, scope, expires_at, consumed_at`

	var c AuthorizationCode
	err := s.pool.QueryRow(ctx, q, codeHash).Scan(
		&c.CodeHash, &c.ClientID, &c.UserID, &c.RedirectURI,
		&c.CodeChallenge, &c.CodeChallengeMethod, &c.Resource, &c.Scope, &c.ExpiresAt, &c.ConsumedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// Unknown, or already consumed. The caller answers both the same way.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consuming authorization code: %w", err)
	}
	return &c, nil
}

// CreateRefreshToken writes the first token of a family.
func (s *PostgresStore) CreateRefreshToken(ctx context.Context, token RefreshToken) error {
	const q = `
		INSERT INTO oauth_refresh_tokens (
			token_hash, family_id, client_id, user_id, resource, scope, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)`

	_, err := s.pool.Exec(ctx, q,
		token.TokenHash, token.FamilyID, token.ClientID, token.UserID,
		token.Resource, token.Scope, token.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("storing refresh token: %w", err)
	}
	return nil
}

// RotateRefreshToken marks the presented token rotated and inserts its
// successor in ONE transaction.
//
// The same conditional-update discipline as the authorization code, for the
// same reason: `rotated_at IS NULL AND revoked_at IS NULL` is evaluated in the
// statement that sets `rotated_at`, so two concurrent presentations of one
// token cannot both succeed. The loser gets no row, which the caller reads as
// possible theft and answers by revoking the family.
//
// The successor is inserted inside the transaction so there is no window in
// which the old token is dead and no new one exists — a crash between the two
// would silently log the user out.
func (s *PostgresStore) RotateRefreshToken(
	ctx context.Context, presentedHash, successorHash string, successorExpiresAt time.Time,
) (*RefreshToken, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("beginning rotation: %w", err)
	}
	// Rollback after a successful Commit is a no-op, so this is safe
	// unconditionally and cannot leak a transaction on an early return.
	defer func() { _ = tx.Rollback(ctx) }()

	const rotate = `
		UPDATE oauth_refresh_tokens
		SET rotated_at = now()
		WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL
		RETURNING token_hash, family_id::text, client_id, user_id, resource, scope, expires_at`

	var parent RefreshToken
	err = tx.QueryRow(ctx, rotate, presentedHash).Scan(
		&parent.TokenHash, &parent.FamilyID, &parent.ClientID, &parent.UserID,
		&parent.Resource, &parent.Scope, &parent.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("rotating refresh token: %w", err)
	}

	const insert = `
		INSERT INTO oauth_refresh_tokens (
			token_hash, family_id, client_id, user_id, resource, scope, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)`
	if _, err := tx.Exec(ctx, insert,
		successorHash, parent.FamilyID, parent.ClientID, parent.UserID,
		parent.Resource, parent.Scope, successorExpiresAt,
	); err != nil {
		return nil, fmt.Errorf("inserting successor refresh token: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("committing rotation: %w", err)
	}
	return &parent, nil
}

// RevokeRefreshTokenFamily kills every token descended from the same
// authorization grant as the presented one.
//
// By FAMILY, not by token, and that is the point. A thief who replays a
// rotated token has proved the token was copied; the legitimate client is by
// then holding a descendant of it, which is equally compromised. Revoking only
// the presented token would leave the thief's own successor alive.
//
// It is one statement with a scalar subquery so the family is resolved and the
// revocation applied atomically, and it is idempotent: a second call revokes
// nothing because `revoked_at IS NULL` no longer matches.
func (s *PostgresStore) RevokeRefreshTokenFamily(ctx context.Context, presentedHash string) (int, error) {
	const q = `
		UPDATE oauth_refresh_tokens
		SET revoked_at = now()
		WHERE revoked_at IS NULL
		  AND family_id = (SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = $1)`

	tag, err := s.pool.Exec(ctx, q, presentedHash)
	if err != nil {
		return 0, fmt.Errorf("revoking refresh token family: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
