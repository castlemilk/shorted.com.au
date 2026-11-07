package shorts

// market_moves_tokens.go: the credentials a market-moves workflow posts with.
//
// An administrator creates them in the admin console (/admin/market-moves),
// whose server actions call the routes below with the INTERNAL_SERVICE_SECRET
// and the admin's address as x-admin-actor (a label for the audit log, never
// authorisation: requireAdmin() is the web's gate, the secret is the API's).
//
//	GET  /api/admin/market-moves/tokens         list every token (never the token itself)
//	POST /api/admin/market-moves/tokens         create one; the answer carries it ONCE
//	POST /api/admin/market-moves/tokens/revoke  revoke one
//
// A token is "smm_" and 43 characters of base64url (32 random bytes). The store
// keeps its SHA-256 and its first ten characters (the prefix the console and the
// log show), so a token that has been shown cannot be read back: one that is
// lost is revoked and replaced. The token is a high-entropy random value, not a
// password, so a plain SHA-256 is the right hash; a slow one would only slow the
// posting door.
//
// The posting door (market_moves_http.go) verifies a presented token through
// marketMovesTokenVerifier: a lookup by hash, cached for marketMovesTokenTTL, so
// a revocation reaches every API instance within that time (the instance that
// revokes forgets the token at once). A store that cannot be read fails closed
// with a 503, never a 401: the token may be good, and a 401 would tell a
// workflow to give up on it.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The admin routes.
const (
	MarketMovesTokensPath      = "/api/admin/market-moves/tokens"
	MarketMovesTokenRevokePath = "/api/admin/market-moves/tokens/revoke"
)

const (
	// marketMovesTokenScheme starts every token, so one is recognisable in a
	// leaked log or a secret scanner, and told apart from the internal secret.
	marketMovesTokenScheme = "smm_"
	marketMovesTokenBytes  = 32
	// marketMovesTokenPrefixLen is how much of a token the console shows.
	marketMovesTokenPrefixLen = len(marketMovesTokenScheme) + 6
	// marketMovesTokenTTL is how long an instance trusts a lookup.
	marketMovesTokenTTL = 30 * time.Second
	// marketMovesTokenMaxDays bounds an expiry. 0 is "never".
	marketMovesTokenMaxDays = 730
	marketMovesTokenNameMax = 80
	marketMovesActorMax     = 254
)

var marketMovesTokenPattern = regexp.MustCompile(`^smm_[A-Za-z0-9_-]{43}$`)

// errMarketMovesTokenRefused: the token is unknown, revoked or expired.
var errMarketMovesTokenRefused = errors.New("market moves token refused")

// newMarketMovesToken returns a new token and the parts of it the store keeps.
func newMarketMovesToken() (token, hash, prefix string, err error) {
	b := make([]byte, marketMovesTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", "", fmt.Errorf("generate market moves token: %w", err)
	}
	token = marketMovesTokenScheme + base64.RawURLEncoding.EncodeToString(b)
	return token, hashMarketMovesToken(token), token[:marketMovesTokenPrefixLen], nil
}

func hashMarketMovesToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// marketMovesTokenActor is the audit identity a token's posts carry.
func marketMovesTokenActor(id int64) string {
	return "token:" + strconv.FormatInt(id, 10)
}

// --- verification ---------------------------------------------------------------

type marketMovesTokenEntry struct {
	row     shortsstore.MarketMovesTokenRow
	found   bool
	expires time.Time
}

// marketMovesTokenVerifier checks a presented token against the store.
type marketMovesTokenVerifier struct {
	store  shortsstore.MarketMovesTokenStore
	logger Logger
	ttl    time.Duration
	now    func() time.Time

	mu      sync.Mutex
	cache   map[string]marketMovesTokenEntry // by hash
	touched map[int64]time.Time
}

func newMarketMovesTokenVerifier(store shortsstore.MarketMovesTokenStore, logger Logger) *marketMovesTokenVerifier {
	if store == nil {
		return nil
	}
	return &marketMovesTokenVerifier{
		store: store, logger: logger, ttl: marketMovesTokenTTL, now: time.Now,
		cache: map[string]marketMovesTokenEntry{}, touched: map[int64]time.Time{},
	}
}

// verify returns the actor of a usable token, errMarketMovesTokenRefused for a
// token that is not one, or the store's error (the caller answers 503).
func (v *marketMovesTokenVerifier) verify(ctx context.Context, token string) (string, error) {
	if v == nil {
		return "", errors.New("market moves tokens are not available on this deployment")
	}
	if !marketMovesTokenPattern.MatchString(token) {
		return "", errMarketMovesTokenRefused
	}
	hash := hashMarketMovesToken(token)
	now := v.now()

	v.mu.Lock()
	entry, ok := v.cache[hash]
	v.mu.Unlock()
	if !ok || now.After(entry.expires) {
		row, found, err := v.store.MarketMovesTokenByHash(ctx, hash)
		if err != nil {
			return "", err // never cached: the next post asks again
		}
		entry = marketMovesTokenEntry{row: row, found: found, expires: now.Add(v.ttl)}
		v.mu.Lock()
		if len(v.cache) > 1000 {
			v.cache = map[string]marketMovesTokenEntry{} // bounded: a flood of junk tokens cannot grow it
		}
		v.cache[hash] = entry
		v.mu.Unlock()
	}
	if !entry.found || !entry.row.Usable(now) {
		return "", errMarketMovesTokenRefused
	}
	v.touch(entry.row.ID, now)
	return marketMovesTokenActor(entry.row.ID), nil
}

// touch records the token's use, at most once a minute per instance, off the
// request path.
func (v *marketMovesTokenVerifier) touch(id int64, now time.Time) {
	v.mu.Lock()
	last, seen := v.touched[id]
	if seen && now.Sub(last) < time.Minute {
		v.mu.Unlock()
		return
	}
	v.touched[id] = now
	v.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := v.store.TouchMarketMovesToken(ctx, id); err != nil && v.logger != nil {
			v.logger.Warnf("market moves: record token %d use: %v", id, err)
		}
	}()
}

// forget drops a token from this instance's cache (after a revocation).
func (v *marketMovesTokenVerifier) forget(hash string) {
	if v == nil {
		return
	}
	v.mu.Lock()
	delete(v.cache, hash)
	v.mu.Unlock()
}

// --- the admin routes -------------------------------------------------------------

// MarketMovesTokenView is a token as the console sees it. It never carries the
// token or its hash.
type MarketMovesTokenView struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	Status     string  `json:"status"` // active | expired | revoked
	CreatedBy  string  `json:"created_by"`
	CreatedAt  string  `json:"created_at"`
	ExpiresAt  *string `json:"expires_at"`
	LastUsedAt *string `json:"last_used_at"`
	RevokedAt  *string `json:"revoked_at"`
	RevokedBy  string  `json:"revoked_by,omitempty"`
}

func marketMovesTokenView(r shortsstore.MarketMovesTokenRow, now time.Time) MarketMovesTokenView {
	ts := func(t *time.Time) *string {
		if t == nil {
			return nil
		}
		s := t.UTC().Format(time.RFC3339)
		return &s
	}
	status := "active"
	switch {
	case r.RevokedAt != nil:
		status = "revoked"
	case r.ExpiresAt != nil && !now.Before(*r.ExpiresAt):
		status = "expired"
	}
	return MarketMovesTokenView{
		ID: r.ID, Name: r.Name, Prefix: r.Prefix, Status: status, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339), ExpiresAt: ts(r.ExpiresAt),
		LastUsedAt: ts(r.LastUsedAt), RevokedAt: ts(r.RevokedAt), RevokedBy: r.RevokedBy,
	}
}

// MarketMovesTokenCreateRequest is the body of POST /api/admin/market-moves/tokens.
type MarketMovesTokenCreateRequest struct {
	Name          string `json:"name"`
	ExpiresInDays int    `json:"expires_in_days"`
}

// MarketMovesTokenRevokeRequest is the body of POST .../tokens/revoke.
type MarketMovesTokenRevokeRequest struct {
	ID int64 `json:"id"`
}

// adminActorLabel is the console's x-admin-actor, bounded. The web sets it from
// the verified admin session; here it is a label, never authorisation.
func adminActorLabel(r *http.Request) string {
	actor := collapseSpace(r.Header.Get("x-admin-actor"))
	if actor == "" || hasControl(actor) {
		return marketMovesInternalActor
	}
	if utf8.RuneCountInString(actor) > marketMovesActorMax {
		actor = string([]rune(actor)[:marketMovesActorMax])
	}
	return actor
}

func tokensUnavailable() *MarketMoveError {
	return &MarketMoveError{Status: http.StatusServiceUnavailable, Code: "unavailable",
		Message: "market-moves tokens are not available on this deployment right now; nothing was changed", Retryable: true}
}

// MarketMovesTokensHandler serves GET (list) and POST (create) on
// /api/admin/market-moves/tokens.
func (s *ShortsServer) MarketMovesTokensHandler() http.HandlerFunc {
	return adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if s.marketMovesTokenStore == nil {
			writeMarketMoveError(w, tokensUnavailable())
			return
		}
		switch r.Method {
		case http.MethodGet:
			rows, err := s.marketMovesTokenStore.ListMarketMovesTokens(r.Context())
			if err != nil {
				s.logger.Errorf("market moves tokens: list: %v", err)
				writeMarketMoveError(w, tokensUnavailable())
				return
			}
			now := time.Now()
			out := make([]MarketMovesTokenView, 0, len(rows))
			for _, row := range rows {
				out = append(out, marketMovesTokenView(row, now))
			}
			writeMarketMovesJSON(w, http.StatusOK, map[string]any{"tokens": out, "max_active": shortsstore.MaxActiveMarketMovesTokens})
		case http.MethodPost:
			s.createMarketMovesToken(w, r)
		default:
			w.Header().Set("Allow", "GET, POST")
			writeMarketMoveError(w, &MarketMoveError{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed", Message: "use GET to list or POST to create"})
		}
	})
}

func (s *ShortsServer) createMarketMovesToken(w http.ResponseWriter, r *http.Request) {
	var in MarketMovesTokenCreateRequest
	if err := decodeStrict(w, r, &in); err != nil {
		writeMarketMoveError(w, err)
		return
	}
	var fields []MarketMoveFieldError
	name := collapseSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > marketMovesTokenNameMax || hasControl(name) {
		fields = append(fields, MarketMoveFieldError{Field: "name", Message: fmt.Sprintf("required: 1 to %d characters naming what will use the token", marketMovesTokenNameMax)})
	}
	if in.ExpiresInDays < 0 || in.ExpiresInDays > marketMovesTokenMaxDays {
		fields = append(fields, MarketMoveFieldError{Field: "expires_in_days", Message: fmt.Sprintf("0 (never) or 1 to %d days", marketMovesTokenMaxDays)})
	}
	if len(fields) > 0 {
		writeMarketMoveError(w, &MarketMoveError{Status: http.StatusUnprocessableEntity, Code: "invalid_token_request", Message: "the token was not created", Fields: fields})
		return
	}
	var expiresAt *time.Time
	if in.ExpiresInDays > 0 {
		t := time.Now().UTC().Add(time.Duration(in.ExpiresInDays) * 24 * time.Hour).Truncate(time.Second)
		expiresAt = &t
	}
	token, hash, prefix, err := newMarketMovesToken()
	if err != nil {
		s.logger.Errorf("market moves tokens: %v", err)
		writeMarketMoveError(w, tokensUnavailable())
		return
	}
	actor := adminActorLabel(r)
	row, err := s.marketMovesTokenStore.CreateMarketMovesToken(r.Context(), name, hash, prefix, actor, expiresAt)
	switch {
	case errors.Is(err, shortsstore.ErrMarketMovesTokenCap):
		writeMarketMoveError(w, &MarketMoveError{Status: http.StatusConflict, Code: "token_cap", Message: storeReason(err, shortsstore.ErrMarketMovesTokenCap)})
		return
	case err != nil:
		s.logger.Errorf("market moves tokens: create: %v", err)
		writeMarketMoveError(w, tokensUnavailable())
		return
	}
	// The token itself is never logged: the prefix names it.
	s.logger.Infof("market moves token created: id=%d prefix=%s name=%q by=%s expires=%v", row.ID, row.Prefix, row.Name, actor, expiresAt)
	writeMarketMovesJSON(w, http.StatusCreated, map[string]any{
		"token": token,
		"meta":  marketMovesTokenView(row, time.Now()),
	})
}

// MarketMovesTokenRevokeHandler serves POST /api/admin/market-moves/tokens/revoke.
func (s *ShortsServer) MarketMovesTokenRevokeHandler() http.HandlerFunc {
	return adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if !requirePost(w, r) {
			return
		}
		if s.marketMovesTokenStore == nil {
			writeMarketMoveError(w, tokensUnavailable())
			return
		}
		var in MarketMovesTokenRevokeRequest
		if err := decodeStrict(w, r, &in); err != nil {
			writeMarketMoveError(w, err)
			return
		}
		if in.ID <= 0 {
			writeMarketMoveError(w, &MarketMoveError{Status: http.StatusUnprocessableEntity, Code: "invalid_token_request", Message: "the token was not revoked",
				Fields: []MarketMoveFieldError{{Field: "id", Message: "required: the token's id"}}})
			return
		}
		actor := adminActorLabel(r)
		row, err := s.marketMovesTokenStore.RevokeMarketMovesToken(r.Context(), in.ID, actor)
		switch {
		case errors.Is(err, shortsstore.ErrMarketMovesTokenNotFound):
			writeMarketMoveError(w, &MarketMoveError{Status: http.StatusNotFound, Code: "not_found", Message: fmt.Sprintf("no token has id %d", in.ID)})
			return
		case err != nil:
			s.logger.Errorf("market moves tokens: revoke %d: %v", in.ID, err)
			writeMarketMoveError(w, tokensUnavailable())
			return
		}
		s.marketMovesTokens.forget(row.Hash)
		s.logger.Infof("market moves token revoked: id=%d prefix=%s by=%s", row.ID, row.Prefix, actor)
		writeMarketMovesJSON(w, http.StatusOK, map[string]any{"meta": marketMovesTokenView(row, time.Now())})
	})
}

// presentedMarketMovesToken is the credential a post carries: the Bearer token,
// or x-market-moves-token.
func presentedMarketMovesToken(r *http.Request) string {
	if t := strings.TrimSpace(r.Header.Get(marketMovesTokenHeader)); t != "" {
		return t
	}
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	}
	return ""
}
