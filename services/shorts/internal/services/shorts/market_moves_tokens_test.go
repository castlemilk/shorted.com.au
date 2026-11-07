package shorts

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// fakeMovesToken is a well-formed token made of one repeated character.
func fakeMovesToken(c string) string { return marketMovesTokenScheme + strings.Repeat(c, 43) }

// testMovesToken is a well-formed token the test server holds (seeded by movesServer).
var testMovesToken = fakeMovesToken("T")

// fakeTokens is an in-memory MarketMovesTokenStore with the store's contract.
type fakeTokens struct {
	mu      sync.Mutex
	rows    []shortsstore.MarketMovesTokenRow
	lookups int
	failing bool
	touched []int64
}

func newFakeTokens() *fakeTokens { return &fakeTokens{} }

func (f *fakeTokens) seed(t *testing.T, token, name string) shortsstore.MarketMovesTokenRow {
	t.Helper()
	row, err := f.CreateMarketMovesToken(context.Background(), name, hashMarketMovesToken(token), token[:marketMovesTokenPrefixLen], "seed", nil)
	require.NoError(t, err)
	return row
}

func (f *fakeTokens) CreateMarketMovesToken(_ context.Context, name, hash, prefix, by string, expiresAt *time.Time) (shortsstore.MarketMovesTokenRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	active := 0
	for _, r := range f.rows {
		if r.Usable(time.Now()) {
			active++
		}
	}
	if active >= shortsstore.MaxActiveMarketMovesTokens {
		return shortsstore.MarketMovesTokenRow{}, shortsstore.ErrMarketMovesTokenCap
	}
	row := shortsstore.MarketMovesTokenRow{ID: int64(len(f.rows) + 1), Name: name, Hash: hash, Prefix: prefix, CreatedBy: by, CreatedAt: time.Now(), ExpiresAt: expiresAt}
	f.rows = append(f.rows, row)
	return row, nil
}

func (f *fakeTokens) ListMarketMovesTokens(context.Context) ([]shortsstore.MarketMovesTokenRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]shortsstore.MarketMovesTokenRow(nil), f.rows...), nil
}

func (f *fakeTokens) RevokeMarketMovesToken(_ context.Context, id int64, by string) (shortsstore.MarketMovesTokenRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, r := range f.rows {
		if r.ID == id {
			if r.RevokedAt == nil {
				now := time.Now()
				r.RevokedAt, r.RevokedBy = &now, by
				f.rows[i] = r
			}
			return r, nil
		}
	}
	return shortsstore.MarketMovesTokenRow{}, shortsstore.ErrMarketMovesTokenNotFound
}

func (f *fakeTokens) MarketMovesTokenByHash(_ context.Context, hash string) (shortsstore.MarketMovesTokenRow, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookups++
	if f.failing {
		return shortsstore.MarketMovesTokenRow{}, false, errors.New("connection refused")
	}
	for _, r := range f.rows {
		if r.Hash == hash {
			return r, true, nil
		}
	}
	return shortsstore.MarketMovesTokenRow{}, false, nil
}

func (f *fakeTokens) TouchMarketMovesToken(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, id)
	return nil
}

func adminRequest(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", "internal-secret")
	req.Header.Set("x-admin-actor", "admin@example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestNewMarketMovesTokenIsRandomAndWellFormed(t *testing.T) {
	a, hashA, prefixA, err := newMarketMovesToken()
	require.NoError(t, err)
	b, _, _, err := newMarketMovesToken()
	require.NoError(t, err)
	assert.NotEqual(t, a, b)
	assert.Regexp(t, `^smm_[A-Za-z0-9_-]{43}$`, a)
	assert.Equal(t, a[:10], prefixA)
	assert.Regexp(t, `^[0-9a-f]{64}$`, hashA)
	assert.NotContains(t, hashA, a[4:], "the hash is not the token")
}

func TestMarketMovesTokenConsoleCreatesListsAndRevokes(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "internal-secret")
	srv := movesServer(t, newFakeMoves("BHP", "RIO", "FMG"))
	tokens := srv.marketMovesTokenStore.(*fakeTokens)
	console := srv.MarketMovesTokensHandler()

	created := adminRequest(t, console, http.MethodPost, MarketMovesTokensPath, `{"name":"  Claude  market\nroutine ","expires_in_days":90}`)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	body := decodeMoveBody(t, created)
	token := body["token"].(string)
	meta := body["meta"].(map[string]any)
	assert.Regexp(t, `^smm_[A-Za-z0-9_-]{43}$`, token)
	assert.Equal(t, "Claude market routine", meta["name"])
	assert.Equal(t, token[:10], meta["prefix"])
	assert.Equal(t, "admin@example.com", meta["created_by"], "the console's actor is recorded")
	assert.Equal(t, "active", meta["status"])
	assert.NotNil(t, meta["expires_at"])
	_, hasHash := meta["hash"]
	assert.False(t, hasHash)

	// The new token posts at once, as itself.
	rec := postJSON(t, srv.MarketMovesPublishHandler(), MarketMovesPath, token, validMove())
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	id := int64(meta["id"].(float64))
	assert.Equal(t, marketMovesTokenActor(id), srv.marketMoves.(*fakeMoves).rows[0].Actor)

	list := adminRequest(t, console, http.MethodGet, MarketMovesTokensPath, "")
	require.Equal(t, http.StatusOK, list.Code)
	assert.NotContains(t, list.Body.String(), token, "a list never carries a token")
	assert.NotContains(t, list.Body.String(), hashMarketMovesToken(token), "nor its hash")
	assert.Contains(t, list.Body.String(), `"max_active":10`)

	revoked := adminRequest(t, srv.MarketMovesTokenRevokeHandler(), http.MethodPost, MarketMovesTokenRevokePath,
		fmt.Sprintf(`{"id":%d}`, id))
	require.Equal(t, http.StatusOK, revoked.Code, revoked.Body.String())
	assert.Equal(t, "revoked", decodeMoveBody(t, revoked)["meta"].(map[string]any)["status"])

	// The instance that revoked forgets the token at once.
	rec = postJSON(t, srv.MarketMovesPublishHandler(), MarketMovesPath, token, validMove())
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, "unauthorized", decodeMoveBody(t, rec)["error"])
	assert.Len(t, tokens.rows, 2, "a revoked token keeps its row")
}

func TestMarketMovesTokenConsoleRefusals(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "internal-secret")
	srv := movesServer(t, newFakeMoves())
	console := srv.MarketMovesTokensHandler()

	t.Run("the console routes need the internal secret", func(t *testing.T) {
		for _, h := range []http.Handler{console, srv.MarketMovesTokenRevokeHandler()} {
			req := httptest.NewRequest(http.MethodPost, MarketMovesTokensPath, strings.NewReader(`{"name":"x"}`))
			req.Header.Set("Authorization", "Bearer "+testMovesToken)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			assert.Equal(t, http.StatusUnauthorized, rec.Code, "a market-moves token cannot mint or revoke tokens")
		}
	})

	t.Run("a name and an expiry in range", func(t *testing.T) {
		rec := adminRequest(t, console, http.MethodPost, MarketMovesTokensPath, `{"name":"","expires_in_days":9999}`)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		fields := []string{}
		for _, f := range decodeMoveBody(t, rec)["fields"].([]any) {
			fields = append(fields, f.(map[string]any)["field"].(string))
		}
		assert.ElementsMatch(t, []string{"name", "expires_in_days"}, fields)
	})

	t.Run("an unknown field is refused", func(t *testing.T) {
		rec := adminRequest(t, console, http.MethodPost, MarketMovesTokensPath, `{"name":"x","scope":"admin"}`)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("never expiring", func(t *testing.T) {
		rec := adminRequest(t, console, http.MethodPost, MarketMovesTokensPath, `{"name":"forever"}`)
		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Nil(t, decodeMoveBody(t, rec)["meta"].(map[string]any)["expires_at"])
	})

	t.Run("the active cap", func(t *testing.T) {
		var last *httptest.ResponseRecorder
		for range 12 {
			last = adminRequest(t, console, http.MethodPost, MarketMovesTokensPath, `{"name":"many"}`)
		}
		assert.Equal(t, http.StatusConflict, last.Code)
		assert.Equal(t, "token_cap", decodeMoveBody(t, last)["error"])
	})

	t.Run("revoking an unknown id", func(t *testing.T) {
		rec := adminRequest(t, srv.MarketMovesTokenRevokeHandler(), http.MethodPost, MarketMovesTokenRevokePath, `{"id":999}`)
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("without a token store", func(t *testing.T) {
		bare := movesServer(t, newFakeMoves())
		bare.marketMovesTokenStore, bare.marketMovesTokens = nil, nil
		rec := adminRequest(t, bare.MarketMovesTokensHandler(), http.MethodGet, MarketMovesTokensPath, "")
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
		post := postJSON(t, bare.MarketMovesPublishHandler(), MarketMovesPath, testMovesToken, validMove())
		assert.Equal(t, http.StatusServiceUnavailable, post.Code, "a token that cannot be checked is not refused as bad")
	})
}

func TestMarketMovesTokenVerifier(t *testing.T) {
	ctx := context.Background()
	tokens := newFakeTokens()
	good := tokens.seed(t, testMovesToken, "good")
	expiredToken := fakeMovesToken("E")
	past := time.Now().Add(-time.Hour)
	expired, err := tokens.CreateMarketMovesToken(ctx, "old", hashMarketMovesToken(expiredToken), expiredToken[:10], "seed", &past)
	require.NoError(t, err)
	v := newMarketMovesTokenVerifier(tokens, nil)
	now := time.Now()
	v.now = func() time.Time { return now }

	actor, err := v.verify(ctx, testMovesToken)
	require.NoError(t, err)
	assert.Equal(t, marketMovesTokenActor(good.ID), actor)

	t.Run("a lookup is cached for the TTL, then asked again", func(t *testing.T) {
		before := tokens.lookups
		_, _ = v.verify(ctx, testMovesToken)
		assert.Equal(t, before, tokens.lookups)
		now = now.Add(marketMovesTokenTTL + time.Second)
		_, _ = v.verify(ctx, testMovesToken)
		assert.Equal(t, before+1, tokens.lookups)
	})

	t.Run("a revocation reaches another instance within the TTL", func(t *testing.T) {
		_, err := tokens.RevokeMarketMovesToken(ctx, good.ID, "admin")
		require.NoError(t, err)
		_, err = v.verify(ctx, testMovesToken)
		assert.NoError(t, err, "still cached on this instance")
		now = now.Add(marketMovesTokenTTL + time.Second)
		_, err = v.verify(ctx, testMovesToken)
		assert.ErrorIs(t, err, errMarketMovesTokenRefused)
	})

	t.Run("expired, unknown and malformed tokens are refused without a lookup for the malformed", func(t *testing.T) {
		_, err := v.verify(ctx, expiredToken)
		assert.ErrorIs(t, err, errMarketMovesTokenRefused, "expired id %d", expired.ID)
		_, err = v.verify(ctx, fakeMovesToken("U"))
		assert.ErrorIs(t, err, errMarketMovesTokenRefused)
		before := tokens.lookups
		_, err = v.verify(ctx, "smm_short")
		assert.ErrorIs(t, err, errMarketMovesTokenRefused)
		assert.Equal(t, before, tokens.lookups)
	})

	t.Run("a store that cannot be read is not a refusal", func(t *testing.T) {
		fresh := newMarketMovesTokenVerifier(tokens, nil)
		tokens.failing = true
		defer func() { tokens.failing = false }()
		_, err := fresh.verify(ctx, testMovesToken)
		require.Error(t, err)
		assert.NotErrorIs(t, err, errMarketMovesTokenRefused)
	})
}
