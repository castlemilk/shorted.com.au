//go:build integration

package oauth

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The interleaving family revocation has to survive.
//
// Run with:
//
//	OAUTH_TEST_DB_URL=postgresql://admin:password@localhost:5438/shorts \
//	  GOWORK=off go test -tags=integration -run RefreshFamily -count=5 ./shorts/internal/oauth/...
//
// OAUTH_TEST_DB_URL is a CAPABILITY GRANT, not a filter: these tests WRITE.

// seedFamily writes n live sibling tokens into one family and returns their
// hashes. Siblings rather than a chain because the race under test is between
// DIFFERENT transactions touching one family, and a chain can only be rotated
// sequentially.
func seedFamily(t *testing.T, store *PostgresStore, clientID, family string, n int) []string {
	t.Helper()
	hashes := make([]string, 0, n)
	for i := 0; i < n; i++ {
		token, err := newRefreshToken()
		if err != nil {
			t.Fatal(err)
		}
		if err := store.CreateRefreshToken(context.Background(), RefreshToken{
			TokenHash: HashCode(token),
			FamilyID:  family,
			ClientID:  clientID,
			UserID:    "itest-uid",
			Resource:  testResource,
			Scope:     "shorts:read",
			ExpiresAt: time.Now().Add(RefreshTokenTTL),
		}); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, HashCode(token))
	}
	return hashes
}

// liveInFamily counts tokens of a family that are still usable.
func liveInFamily(t *testing.T, pool *pgxpool.Pool, family string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM oauth_refresh_tokens
		WHERE family_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL`,
		family).Scan(&n); err != nil {
		t.Fatalf("counting live tokens: %v", err)
	}
	return n
}

// PROOF (deterministic): a rotation that is in flight when a family is revoked
// does not smuggle a live successor out the other side.
//
// The exact sequence, driven rather than hoped for:
//
//  1. A legitimate rotation reaches the point where the parent is marked rotated
//     and the successor is INSERTed, but the transaction is NOT yet committed.
//  2. The thief presents the stolen ancestor, so RevokeRefreshTokenFamily runs.
//  3. The rotation commits.
//  4. The revocation completes.
//
// Against the pre-fix store this FAILS: the revoking UPDATE takes its snapshot
// at step 2, before the successor exists, so it revokes only the rows it can
// see and the successor survives a revocation that reported success. An attacker
// who can time a rotation against the victim's reuse-triggered revocation keeps
// a live token — which is the entire control this feature exists to provide.
func TestRefreshFamilyRevocationDoesNotLoseAConcurrentRotation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)

	family := uuid.NewString()
	hashes := seedFamily(t, store, clientID, family, 1)
	parentHash := hashes[0]

	successor, err := newRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	successorHash := HashCode(successor)

	// The rotation pauses with its successor inserted and uncommitted, and does
	// not resume until the revocation has been given time to reach the database.
	revocationStarted := make(chan struct{})
	rotateBeforeCommitHook = func() {
		close(revocationStarted)
		// Long enough for the revoking statement to have been issued and to be
		// waiting on the parent's row lock. Sleeping here is safe: the assertion
		// below does not depend on the sleep being long enough to prove the bug —
		// the survivor check is what fails, and a too-short sleep only makes the
		// race less likely to be hit, never a false pass.
		time.Sleep(400 * time.Millisecond)
	}
	t.Cleanup(func() { rotateBeforeCommitHook = nil })

	var (
		wg      sync.WaitGroup
		revoked int
		revErr  error
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-revocationStarted
		revoked, revErr = store.RevokeRefreshTokenFamily(ctx, parentHash)
	}()

	parent, err := store.RotateRefreshToken(ctx, parentHash, successorHash, time.Now().Add(RefreshTokenTTL))
	if err != nil {
		t.Fatalf("rotation: %v", err)
	}
	if parent == nil {
		t.Fatal("the rotation did not win its own uncontended conditional update")
	}
	wg.Wait()
	if revErr != nil {
		t.Fatalf("family revocation: %v", revErr)
	}

	var successorRevoked bool
	if err := pool.QueryRow(ctx,
		`SELECT revoked_at IS NOT NULL FROM oauth_refresh_tokens WHERE token_hash = $1`,
		successorHash).Scan(&successorRevoked); err != nil {
		t.Fatalf("reading the successor back: %v", err)
	}
	live := liveInFamily(t, pool, family)

	t.Logf("family revocation reported %d rows", revoked)
	if !successorRevoked || live != 0 {
		t.Fatalf("SURVIVOR: the successor inserted by a concurrent rotation is NOT revoked; "+
			"%d live tokens remain in a revoked family", live)
	}
}

// PROOF (stochastic): the same property under real contention, with no hook.
//
// SIXTY-FOUR racers, and the number is not decoration. The reviewer's mutation
// test of the code-consume path passed at 8 concurrent racers and only failed at
// 64 — a lost-update window is a few hundred microseconds of one transaction, so
// a small pool of racers simply does not land inside it often enough to be
// evidence. Sixty-four rotations against one revocation, five times over,
// samples the window hard enough for a green run to mean something.
//
// The invariant is absolute, not statistical: whichever order the transactions
// land in, once the revocation has committed the family must hold NO live token.
// A rotation that got in first leaves a successor the revocation must see; a
// rotation that arrives later finds its parent revoked and mints nothing.
func TestRefreshFamilyRevocationBeatsSixtyFourConcurrentRotations(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	clientID := seedClient(t, pool)

	const racers = 64
	family := uuid.NewString()
	hashes := seedFamily(t, store, clientID, family, racers)

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		errs  []error
		start = make(chan struct{})
	)
	for _, h := range hashes {
		wg.Add(1)
		go func(presented string) {
			defer wg.Done()
			successor, err := newRefreshToken()
			if err != nil {
				return
			}
			<-start
			if _, err := store.RotateRefreshToken(ctx, presented, HashCode(successor), time.Now().Add(RefreshTokenTTL)); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}(h)
	}
	// The revocation starts alongside them, presenting a token from the middle of
	// the pack so it is contending rather than arriving first or last.
	wg.Add(1)
	var revoked int
	go func() {
		defer wg.Done()
		<-start
		n, err := store.RevokeRefreshTokenFamily(ctx, hashes[racers/2])
		mu.Lock()
		revoked = n
		if err != nil {
			errs = append(errs, err)
		}
		mu.Unlock()
	}()

	close(start)
	wg.Wait()

	// A deadlock would surface here, not as a hang: Postgres breaks a cycle by
	// aborting one transaction with SQLSTATE 40P01. Any error at all fails the
	// test, so trading a lost update for a deadlock cannot pass silently.
	if len(errs) != 0 {
		t.Fatalf("errors during the race (a 40P01 here means the two paths take their locks in different orders): %v", errs)
	}
	if revoked == 0 {
		t.Fatal("the revocation revoked nothing, so this proved nothing")
	}
	if live := liveInFamily(t, pool, family); live != 0 {
		t.Fatalf("SURVIVOR: %d live tokens remain in a family that was revoked (%d rows revoked)", live, revoked)
	}
}
