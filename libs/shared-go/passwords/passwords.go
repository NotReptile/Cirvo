package passwords

import (
	"errors"

	"golang.org/x/crypto/bcrypt"
)

const defaultCost = 12

var ErrMismatch = errors.New("password does not match")

func Hash(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), defaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func Verify(hash string, plain string) error {
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)); err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return ErrMismatch
		}
		return err
	}
	return nil
}
