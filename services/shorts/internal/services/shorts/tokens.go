package shorts

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	jwt.RegisteredClaims
	UserID string   `json:"user_id"`
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
	Tier   string   `json:"tier,omitempty"` // Subscription tier: free, pro, enterprise
}

type TokenService struct {
	secret []byte
}

func NewTokenService(secret string) *TokenService {
	return &TokenService{
		secret: []byte(secret),
	}
}

// MintToken creates a new JWT for a user with specific roles.
func (s *TokenService) MintToken(userID, email string, roles []string, duration time.Duration) (string, error) {
	return s.MintTokenWithTier(userID, email, roles, "free", duration)
}

// MintTokenWithTier creates a new JWT for a user with specific roles and subscription tier.
func (s *TokenService) MintTokenWithTier(userID, email string, roles []string, tier string, duration time.Duration) (string, error) {
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(duration)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "shorted-api",
		},
		UserID: userID,
		Email:  email,
		Roles:  roles,
		Tier:   tier,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

// ValidateToken parses and validates a JWT.
func (s *TokenService) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secret, nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}



