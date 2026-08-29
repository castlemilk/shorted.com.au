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
	_ TokenStore   = (*PostgresStore)(nil)
	_ ClientStore  = (*PostgresStore)(nil)
	_ ConsentStore = (*PostgresStore)(nil)
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
//
// At this layer GetClient and GetRegisteredClient are the SAME read — a stored
// row is a stored row. They diverge one layer up, where ResolvingStore
// overrides GetClient to resolve a CIMD client_id by fetching its metadata
// document, and deliberately does NOT override GetRegisteredClient. That is
// what lets the refresh grant ask for the persisted registration and get it,
// without a network call, through the very same wrapper.
func (s *PostgresStore) GetClient(ctx context.Context, clientID string) (*Client, error) {
	return s.registeredClient(ctx, clientID)
}

// GetRegisteredClient returns the persisted registration row and never resolves
// a metadata document. See the note on TokenStore.GetRegisteredClient for why
// the refresh grant must not depend on a third party being reachable.
func (s *PostgresStore) GetRegisteredClient(ctx context.Context, clientID string) (*Client, error) {
	return s.registeredClient(ctx, clientID)
}

func (s *PostgresStore) registeredClient(ctx context.Context, clientID string) (*Client, error) {
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

// CreateConsentTicket writes the hashed proof that a human approved.
func (s *PostgresStore) CreateConsentTicket(ctx context.Context, ticket ConsentTicket) error {
	const q = `
		INSERT INTO oauth_consent_tickets (
			ticket_hash, user_id, client_id, redirect_uri,
			code_challenge, resource, scope, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

	_, err := s.pool.Exec(ctx, q,
		ticket.TicketHash, ticket.UserID, ticket.ClientID, ticket.RedirectURI,
		ticket.CodeChallenge, ticket.Resource, ticket.Scope, ticket.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("storing consent ticket: %w", err)
	}
	return nil
}

// ConsumeConsentTicket redeems a ticket in ONE statement, for exactly the
// reason ConsumeAuthorizationCode does: the predicate that decides whether it
// is still spendable is evaluated inside the statement that spends it, so two
// concurrent presentations cannot both win.
//
// One approval must buy one authorization code. Without this, a leaked ticket
// could be replayed into as many codes as the attacker cared to request, and
// the human's single approval would authorise an unbounded number of grants.
//
// Expiry stays out of the predicate so "already used" and "expired" remain
// distinguishable in the logs; the caller refuses an expired ticket a moment
// later, and it has been consumed either way.
func (s *PostgresStore) ConsumeConsentTicket(ctx context.Context, ticketHash string) (*ConsentTicket, error) {
	const q = `
		UPDATE oauth_consent_tickets
		SET consumed_at = now()
		WHERE ticket_hash = $1 AND consumed_at IS NULL
		RETURNING ticket_hash, user_id, client_id, redirect_uri,
		          code_challenge, resource, scope, expires_at, consumed_at`

	var t ConsentTicket
	err := s.pool.QueryRow(ctx, q, ticketHash).Scan(
		&t.TicketHash, &t.UserID, &t.ClientID, &t.RedirectURI,
		&t.CodeChallenge, &t.Resource, &t.Scope, &t.ExpiresAt, &t.ConsumedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// Unknown, or already spent. Both mean "no approval to rely on".
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consuming consent ticket: %w", err)
	}
	return &t, nil
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

// GetRefreshToken reads a token row WITHOUT changing it, so the token endpoint
// can check a presentation before deciding whether to spend it. Unknown token:
// (nil, nil).
//
// It returns rotated and revoked rows too. The caller needs to SEE that state —
// a dead token presented again is the reuse signal — and hiding it here would
// make "unknown" and "already used" indistinguishable at exactly the layer that
// has to tell them apart.
//
// This read decides NOTHING on its own. RotateRefreshToken remains the atomic
// single-use gate; anything learned here is advisory, in the same way
// validVerifier's shape check is advisory ahead of the code consume.
func (s *PostgresStore) GetRefreshToken(ctx context.Context, tokenHash string) (*RefreshToken, error) {
	const q = `
		SELECT token_hash, family_id::text, client_id, user_id, resource, scope,
		       expires_at, rotated_at, revoked_at
		FROM oauth_refresh_tokens
		WHERE token_hash = $1`

	// rotated_at and revoked_at are nullable, and NULL is the LIVE state. Scanned
	// through pointers so a NULL stays distinguishable from a zero timestamp
	// rather than being coalesced into one.
	var (
		rotated, revoked *time.Time
		out              RefreshToken
	)
	err := s.pool.QueryRow(ctx, q, tokenHash).Scan(
		&out.TokenHash, &out.FamilyID, &out.ClientID, &out.UserID, &out.Resource, &out.Scope,
		&out.ExpiresAt, &rotated, &revoked,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("loading refresh token: %w", err)
	}
	if rotated != nil {
		out.RotatedAt = *rotated
	}
	if revoked != nil {
		out.RevokedAt = *revoked
	}
	return &out, nil
}

// familyLockSQL serialises every transaction that mutates one refresh-token
// family.
//
// WHY A LOCK AT ALL, WHEN BOTH PATHS ARE ALREADY CONDITIONAL UPDATES. Row locks
// only serialise transactions that contend on the SAME ROW, and rotation and
// revocation do not: rotation writes a row that revocation has not read yet.
// Under READ COMMITTED a statement takes its snapshot when it STARTS, so a
// revoking UPDATE that begins while a rotation is mid-transaction sees the
// family as it was before the successor was inserted. It then blocks on the
// parent's row lock, the rotation commits, EvalPlanQual re-checks the ROW it was
// waiting on — and the successor, which never existed in its snapshot, is simply
// not part of the scan. The revocation reports success and leaves a live token
// in a family it just declared compromised.
//
// pg_advisory_xact_lock closes that window because it is taken BEFORE the
// revoking statement runs, so the revoke's UPDATE is issued as a fresh
// statement, with a fresh snapshot, after any rotation on this family has
// committed and released the lock.
//
// LOCK ORDERING. Both paths take exactly ONE lock before touching any row: this
// advisory lock, keyed on family_id, and nothing else. Row locks are only ever
// acquired while already holding it, and a transaction holds at most one of
// them, so there is no second resource to order against and no cycle to form.
// Getting this backwards — locking the row first and the family second, which is
// what "take the lock once family_id is known from the UPDATE's RETURNING"
// would mean — trades the lost update for a genuine deadlock: the rotation would
// hold the parent's row lock while waiting on the advisory lock, and the
// revocation would hold the advisory lock while waiting on that same row. That
// is why both paths resolve family_id with a PLAIN, UNLOCKING read first.
// family_id is immutable for the life of a row, so reading it without a lock
// cannot go stale.
//
// hashtextextended maps the uuid onto the bigint keyspace pg_advisory_xact_lock
// requires. A collision between two families costs a little needless
// serialisation and nothing else.
const familyLockSQL = `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`

// familyOfSQL resolves a presented token's family WITHOUT locking it.
const familyOfSQL = `SELECT family_id::text FROM oauth_refresh_tokens WHERE token_hash = $1`

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
//
// The whole transaction runs under the family advisory lock, so a revocation
// racing it either observes the successor or does not run until this has
// finished. See familyLockSQL.
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

	// Resolve the family and take its lock BEFORE any row is touched — the lock
	// order the revocation path also uses. An unknown token has no family and no
	// row to rotate, so it never takes a lock at all.
	var family string
	err = tx.QueryRow(ctx, familyOfSQL, presentedHash).Scan(&family)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolving refresh token family: %w", err)
	}
	if _, err := tx.Exec(ctx, familyLockSQL, family); err != nil {
		return nil, fmt.Errorf("locking refresh token family: %w", err)
	}

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

	if hook := rotateBeforeCommitHook; hook != nil {
		hook()
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("committing rotation: %w", err)
	}
	return &parent, nil
}

// rotateBeforeCommitHook is TEST-ONLY SCAFFOLDING. It is nil in every build that
// ships, and production pays exactly one nil check per rotation for it.
//
// DO NOT DELETE IT AS DEAD CODE. It has no non-test caller by design, so it
// looks removable and is not: deleting it silently downgrades
// TestRefreshFamilyRevocationDoesNotLoseAConcurrentRotation from a proof to a
// guess, and the bug it pins is a stolen refresh token surviving the revocation
// that was supposed to kill it.
//
// WHY IT HAS TO EXIST. The interleaving family revocation must survive is a
// rotation that has INSERTed its successor but not yet COMMITTED, racing a
// revocation. That instant is inside this transaction and is not observable
// from outside it, so the only ways to test it are to hold the real rotation
// open here, or to re-implement this function's SQL in the test and race that
// instead. The second is strictly weaker: it proves the test agrees with the
// test, and it goes on passing after somebody changes the SQL in this file.
// The hook makes the assertion run against the code that actually ships.
var rotateBeforeCommitHook func()

// RevokeRefreshTokenFamily kills every token descended from the same
// authorization grant as the presented one.
//
// By FAMILY, not by token, and that is the point. A thief who replays a
// rotated token has proved the token was copied; the legitimate client is by
// then holding a descendant of it, which is equally compromised. Revoking only
// the presented token would leave the thief's own successor alive.
//
// It resolves the family FIRST, takes the family advisory lock, and only then
// revokes — the same lock, in the same order, as RotateRefreshToken. That
// ordering is the fix for the interleaving proved by
// TestRefreshFamilyRevocationDoesNotLoseAConcurrentRotation: a single
// self-contained UPDATE with a scalar subquery looks atomic and is not, because
// its snapshot predates any rotation still in flight and the successor that
// rotation is about to commit is therefore invisible to it. See familyLockSQL.
//
// It stays idempotent: a second call revokes nothing because `revoked_at IS
// NULL` no longer matches. An unknown token has no family, takes no lock, and
// revokes nothing.
func (s *PostgresStore) RevokeRefreshTokenFamily(ctx context.Context, presentedHash string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("beginning family revocation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var family string
	err = tx.QueryRow(ctx, familyOfSQL, presentedHash).Scan(&family)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("resolving refresh token family: %w", err)
	}
	if _, err := tx.Exec(ctx, familyLockSQL, family); err != nil {
		return 0, fmt.Errorf("locking refresh token family: %w", err)
	}

	// A SEPARATE statement, deliberately: under READ COMMITTED this takes its
	// snapshot now — after the lock was granted, and therefore after every
	// rotation that held it has committed — so a successor inserted by one of
	// them is in scope.
	const revoke = `
		UPDATE oauth_refresh_tokens
		SET revoked_at = now()
		WHERE family_id = $1 AND revoked_at IS NULL`

	tag, err := tx.Exec(ctx, revoke, family)
	if err != nil {
		return 0, fmt.Errorf("revoking refresh token family: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("committing family revocation: %w", err)
	}
	return int(tag.RowsAffected()), nil
}
