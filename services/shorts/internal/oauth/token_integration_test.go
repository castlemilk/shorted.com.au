//go:build integration

package oauth

import (
	"context"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These are the properties that CANNOT be proved with a fake: single-use and
// rotation are guarantees of the SQL, not of the handler. Run with:
//
//	OAUTH_TEST_DB_URL=postgresql://admin:password@localhost:5438/shorts \
//	  GOWORK=off go test -tags=integration ./shorts/internal/oauth/...
//
// OAUTH_TEST_DB_URL is a CAPABILITY GRANT, not a filter: this test WRITES.

// seedClient registers a throwaway client and removes it (and, by cascade,
// every code and refresh token under it) afterwards.
func seedClient(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	clientID := "itest-token-" + uuid.NewString()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, registration_source)
		VALUES ($1, 'Token Integration Client', $2, ARRAY['authorization_code','refresh_token'], 'dcr')`,
		clientID, []string{testRedirectURI}); err != nil {
		t.Fatalf("seeding client: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_clients WHERE client_id = $1`, clientID)
	})
	return clientID
}

func seedDBCode(t *testing.T, store *PostgresStore, clientID string) string {
	t.Helper()
	code, err := newAuthorizationCode()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAuthorizationCode(context.Background(), AuthorizationCode{
		CodeHash:            HashCode(code),
		ClientID:            clientID,
		UserID:              "itest-uid",
		RedirectURI:         testRedirectURI,
		CodeChallenge:       testChallenge,
		CodeChallengeMethod: "S256",
		Resource:            testResource,
		Scope:               "shorts:read housing:read",
		ExpiresAt:           time.Now().Add(CodeTTL),
	}); err != nil {
		t.Fatalf("seeding code: %v", err)
	}
	return code
}

// PROOF: a replayed code loses the race, against a real database.
//
// Sixty-four goroutines present the SAME code simultaneously. The conditional UPDATE
// means exactly one may see a row; the rest must see nothing. A read-then-write
// implementation fails this — verified by mutating the store to SELECT-then-
// UPDATE, which produced 64 winners out of 64 on every one of five runs.
func TestConcurrentRedemptionOfOneCodeHasExactlyOneWinner(t *testing.T) {
	pool := testPool(t)
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)
	code := seedDBCode(t, store, clientID)

	const racers = 64
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		errs    []error
	)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec, err := store.ConsumeAuthorizationCode(context.Background(), HashCode(code))
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			if rec != nil {
				winners++
			}
		}()
	}
	close(start)
	wg.Wait()

	if len(errs) != 0 {
		t.Fatalf("consume errors: %v", errs)
	}
	if winners != 1 {
		t.Fatalf("%d of %d concurrent redemptions succeeded, want exactly 1", winners, racers)
	}

	// And the row is consumed exactly once, not once per winner.
	var consumed *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash = $1`, HashCode(code)).
		Scan(&consumed); err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if consumed == nil {
		t.Fatal("the winning redemption did not mark the code consumed")
	}
}

// The same property through the HANDLER, which is what actually ships: one 200
// and one 400, and only one refresh token in the database.
func TestReplayedCodeThroughTheHandlerMintsOnce(t *testing.T) {
	pool := testPool(t)
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)
	code := seedDBCode(t, store, clientID)

	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	form := codeForm(code, testVerifier)
	form.Set("client_id", clientID)

	if rec := postForm(t, h, form); rec.Code != 200 {
		t.Fatalf("first redemption: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postForm(t, h, form); rec.Code != 400 {
		t.Fatalf("replay: %d %s, want 400", rec.Code, rec.Body.String())
	}
	if minter.n != 1 {
		t.Errorf("minted %d access tokens, want 1", minter.n)
	}

	var refreshRows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM oauth_refresh_tokens WHERE client_id = $1`, clientID).Scan(&refreshRows); err != nil {
		t.Fatal(err)
	}
	if refreshRows != 1 {
		t.Errorf("%d refresh tokens issued across a redemption and a replay, want 1", refreshRows)
	}
}

// PROOF: refresh reuse revokes the family, against a real database.
//
// Rotate twice, then present the FIRST token. Every row of the family — the
// newest one included, the one the legitimate client is holding — must come
// back revoked.
func TestRefreshReuseRevokesTheFamilyInPostgres(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)

	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	form := codeForm(seedDBCode(t, store, clientID), testVerifier)
	form.Set("client_id", clientID)
	rec := postForm(t, h, form)
	if rec.Code != 200 {
		t.Fatalf("redemption: %d %s", rec.Code, rec.Body.String())
	}
	first, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)

	rf := func(token string) url.Values {
		return url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {token},
			"client_id":     {clientID},
		}
	}
	rec = postForm(t, h, rf(first))
	if rec.Code != 200 {
		t.Fatalf("first rotation: %d %s", rec.Code, rec.Body.String())
	}
	second, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)
	rec = postForm(t, h, rf(second))
	if rec.Code != 200 {
		t.Fatalf("second rotation: %d %s", rec.Code, rec.Body.String())
	}
	third, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)

	liveInDB := func(token string) bool {
		var live bool
		if err := pool.QueryRow(ctx, `
			SELECT rotated_at IS NULL AND revoked_at IS NULL
			FROM oauth_refresh_tokens WHERE token_hash = $1`, HashCode(token)).Scan(&live); err != nil {
			t.Fatalf("reading %s: %v", token[:8], err)
		}
		return live
	}
	if !liveInDB(third) {
		t.Fatal("the newest token is not live before the reuse")
	}

	// The theft: the first token, two rotations old, is presented again.
	if rec := postForm(t, h, rf(first)); rec.Code != 400 {
		t.Fatalf("reuse: %d %s, want 400", rec.Code, rec.Body.String())
	}

	var total, revoked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE revoked_at IS NOT NULL)
		FROM oauth_refresh_tokens WHERE client_id = $1`, clientID).Scan(&total, &revoked); err != nil {
		t.Fatal(err)
	}
	if total != 3 || revoked != 3 {
		t.Errorf("%d of %d tokens in the family revoked, want all of them", revoked, total)
	}
	if liveInDB(third) {
		t.Error("the newest refresh token survived a reuse of its ancestor")
	}
	if rec := postForm(t, h, rf(third)); rec.Code == 200 {
		t.Error("the newest refresh token still works after the family was revoked")
	}
}

// Rotation is atomic against a concurrent second use of the same token: two
// callers present it simultaneously, exactly one may rotate it.
func TestConcurrentRotationOfOneRefreshTokenHasExactlyOneWinner(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)

	token, err := newRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateRefreshToken(ctx, RefreshToken{
		TokenHash: HashCode(token),
		FamilyID:  uuid.NewString(),
		ClientID:  clientID,
		UserID:    "itest-uid",
		Resource:  testResource,
		Scope:     "shorts:read",
		ExpiresAt: time.Now().Add(RefreshTokenTTL),
	}); err != nil {
		t.Fatal(err)
	}

	const racers = 32
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		errs    []error
	)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			successor, err := newRefreshToken()
			if err != nil {
				return
			}
			<-start
			parent, err := store.RotateRefreshToken(ctx, HashCode(token), HashCode(successor), time.Now().Add(RefreshTokenTTL))
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			if parent != nil {
				winners++
			}
		}()
	}
	close(start)
	wg.Wait()

	if len(errs) != 0 {
		t.Fatalf("rotation errors: %v", errs)
	}
	if winners != 1 {
		t.Fatalf("%d of %d concurrent rotations succeeded, want exactly 1", winners, racers)
	}

	// Exactly one successor exists — a lost race must not leave an orphan.
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM oauth_refresh_tokens WHERE client_id = $1`, clientID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Errorf("%d refresh token rows after a contended rotation, want 2 (parent + one successor)", rows)
	}
}

// A revoked family stays revoked, and re-revoking is a no-op rather than an
// error — the handler calls it on every failed presentation.
func TestFamilyRevocationIsIdempotentAndUnknownTokensRevokeNothing(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)

	family := uuid.NewString()
	var hashes []string
	for i := 0; i < 3; i++ {
		token, err := newRefreshToken()
		if err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, HashCode(token))
		if err := store.CreateRefreshToken(ctx, RefreshToken{
			TokenHash: HashCode(token),
			FamilyID:  family,
			ClientID:  clientID,
			UserID:    "itest-uid",
			Resource:  testResource,
			ExpiresAt: time.Now().Add(RefreshTokenTTL),
		}); err != nil {
			t.Fatal(err)
		}
	}

	n, err := store.RevokeRefreshTokenFamily(ctx, hashes[1])
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("revoked %d, want the whole family of 3", n)
	}
	if n, err := store.RevokeRefreshTokenFamily(ctx, hashes[1]); err != nil || n != 0 {
		t.Errorf("second revocation = %d, %v; want 0, nil", n, err)
	}
	if n, err := store.RevokeRefreshTokenFamily(ctx, HashCode("no-such-token")); err != nil || n != 0 {
		t.Errorf("unknown token revocation = %d, %v; want 0, nil", n, err)
	}
}
