// Package accountrules — единые правила для email, username и пароля.
// Раньше они дублировались в auth (регистрация) и bootstrap (первый админ);
// теперь их используют и они, и создание пользователя из админки.
package accountrules

import (
	"crypto/rand"
	"errors"
	"math/big"
	"regexp"
	"strings"
)

const (
	MinPasswordLength = 8
	maxEmailLength    = 254
)

var (
	ErrInvalidEmail    = errors.New("invalid email")
	ErrInvalidUsername = errors.New("username must be 3-32 chars of [a-z0-9_]")
	ErrShortPassword   = errors.New("password must be at least 8 characters")

	usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)
)

func NormalizeEmail(s string) string    { return strings.ToLower(strings.TrimSpace(s)) }
func NormalizeUsername(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// ValidateEmail проверяет уже нормализованный email: минимум правил (есть «@»,
// нет пробелов, длина не больше 254). Настоящую проверку делает подтверждение
// по почте, которого пока нет.
func ValidateEmail(email string) error {
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t\r\n") || len(email) > maxEmailLength {
		return ErrInvalidEmail
	}
	return nil
}

func ValidateUsername(username string) error {
	if !usernamePattern.MatchString(username) {
		return ErrInvalidUsername
	}
	return nil
}

func ValidatePassword(password string) error {
	if len(password) < MinPasswordLength {
		return ErrShortPassword
	}
	return nil
}

// Алфавит без похожих знаков (0/O, 1/l/I): временный пароль диктуют голосом
// или переписывают с экрана.
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"

// GeneratePassword возвращает случайный пароль длины n из криптостойкого
// источника. Для n < MinPasswordLength берётся MinPasswordLength.
func GeneratePassword(n int) (string, error) {
	if n < MinPasswordLength {
		n = MinPasswordLength
	}
	out := make([]byte, n)
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := range out {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = passwordAlphabet[idx.Int64()]
	}
	return string(out), nil
}
