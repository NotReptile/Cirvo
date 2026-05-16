package jwtauth

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpiredToken = errors.New("token expired")
)

type Claims struct {
	UserID    uuid.UUID `json:"-"`
	SessionID uuid.UUID `json:"-"`
	jwt.RegisteredClaims
}

type Issuer struct {
	secret       []byte
	issuer       string
	accessTTL    time.Duration
	refreshBytes int
}

func NewIssuerFromEnv(serviceName string) (*Issuer, error) {
	secret := os.Getenv("RUCORD_JWT_SECRET")
	if secret == "" {
		return nil, errors.New("RUCORD_JWT_SECRET is not configured")
	}
	if len(secret) < 32 {
		return nil, errors.New("RUCORD_JWT_SECRET must be at least 32 characters")
	}
	ttl := 15 * time.Minute
	if v := os.Getenv("RUCORD_JWT_ACCESS_TTL"); v != "" {
		parsed, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("invalid RUCORD_JWT_ACCESS_TTL: %w", err)
		}
		ttl = parsed
	}
	return &Issuer{
		secret:       []byte(secret),
		issuer:       serviceName,
		accessTTL:    ttl,
		refreshBytes: 32,
	}, nil
}

func (i *Issuer) AccessTTL() time.Duration {
	return i.accessTTL
}

func (i *Issuer) IssueAccess(userID, sessionID uuid.UUID) (string, time.Time, error) {
	now := time.Now().UTC()
	expires := now.Add(i.accessTTL)
	claims := jwt.MapClaims{
		"sub": userID.String(),
		"sid": sessionID.String(),
		"iss": i.issuer,
		"iat": now.Unix(),
		"exp": expires.Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(i.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expires, nil
}

func (i *Issuer) Parse(raw string) (Claims, error) {
	parsed, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return i.secret, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return Claims{}, ErrExpiredToken
		}
		return Claims{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if !parsed.Valid {
		return Claims{}, ErrInvalidToken
	}
	raw2, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return Claims{}, ErrInvalidToken
	}
	subStr, _ := raw2["sub"].(string)
	sidStr, _ := raw2["sid"].(string)
	userID, err := uuid.Parse(subStr)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	sessionID, err := uuid.Parse(sidStr)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	return Claims{UserID: userID, SessionID: sessionID}, nil
}
