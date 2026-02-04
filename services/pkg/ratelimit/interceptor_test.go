package ratelimit

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// mockUserClaims implements UserClaims for testing
type mockUserClaims struct {
	userID    string
	tier      string
	isBrowser bool
}

func (m *mockUserClaims) GetUserID() string {
	return m.userID
}

func (m *mockUserClaims) GetTier() string {
	return m.tier
}

func (m *mockUserClaims) GetIsBrowserAuth() bool {
	return m.isBrowser
}

func TestUserClaimsInterface(t *testing.T) {
	claims := &mockUserClaims{userID: "user-123", tier: "pro"}

	// Verify it implements UserClaims
	var uc UserClaims = claims
	assert.Equal(t, "user-123", uc.GetUserID())
	assert.Equal(t, "pro", uc.GetTier())
}

func TestUserClaimsContextKey(t *testing.T) {
	// Verify the default key is defined
	assert.Equal(t, UserClaimsContextKey("user"), DefaultUserClaimsKey)
}
