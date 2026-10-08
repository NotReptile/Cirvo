package accountrules

import (
	"strings"
	"testing"
)

func TestValidateEmail(t *testing.T) {
	good := []string{"a@b.c", "user.name+tag@example.com"}
	for _, e := range good {
		if err := ValidateEmail(e); err != nil {
			t.Errorf("ValidateEmail(%q) = %v, want nil", e, err)
		}
	}
	bad := []string{"", "no-at-sign", "has space@example.com", "a@b.c\n", strings.Repeat("a", 251) + "@b.c"}
	for _, e := range bad {
		if err := ValidateEmail(e); err != ErrInvalidEmail {
			t.Errorf("ValidateEmail(%q) = %v, want ErrInvalidEmail", e, err)
		}
	}
}

func TestValidateUsername(t *testing.T) {
	for _, u := range []string{"abc", "qa_admin", "user_123", strings.Repeat("a", 32)} {
		if err := ValidateUsername(u); err != nil {
			t.Errorf("ValidateUsername(%q) = %v, want nil", u, err)
		}
	}
	for _, u := range []string{"", "ab", "Upper", "with-dash", "with space", strings.Repeat("a", 33)} {
		if err := ValidateUsername(u); err != ErrInvalidUsername {
			t.Errorf("ValidateUsername(%q) = %v, want ErrInvalidUsername", u, err)
		}
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("12345678"); err != nil {
		t.Errorf("8 символов должны проходить: %v", err)
	}
	if err := ValidatePassword("1234567"); err != ErrShortPassword {
		t.Errorf("7 символов: %v, want ErrShortPassword", err)
	}
	if err := ValidatePassword(strings.Repeat("a", 72)); err != nil {
		t.Errorf("72 байта должны проходить: %v", err)
	}
	if err := ValidatePassword(strings.Repeat("a", 73)); err != ErrLongPassword {
		t.Errorf("73 байта: %v, want ErrLongPassword", err)
	}
	// Предел считается в байтах, не в символах: 37 русских букв = 74 байта.
	if err := ValidatePassword(strings.Repeat("я", 37)); err != ErrLongPassword {
		t.Errorf("37 кириллических символов (74 байта): %v, want ErrLongPassword", err)
	}
}

func TestNormalize(t *testing.T) {
	if got := NormalizeEmail("  User@Example.COM "); got != "user@example.com" {
		t.Errorf("NormalizeEmail = %q", got)
	}
	if got := NormalizeUsername(" QA_Admin "); got != "qa_admin" {
		t.Errorf("NormalizeUsername = %q", got)
	}
}

func TestGeneratePassword(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		p, err := GeneratePassword(16)
		if err != nil {
			t.Fatal(err)
		}
		if len(p) != 16 {
			t.Fatalf("длина %d, want 16", len(p))
		}
		for _, c := range p {
			if !strings.ContainsRune(passwordAlphabet, c) {
				t.Fatalf("символ %q вне алфавита", c)
			}
		}
		if seen[p] {
			t.Fatalf("повтор пароля %q", p)
		}
		seen[p] = true
	}
	short, err := GeneratePassword(3)
	if err != nil || len(short) != MinPasswordLength {
		t.Errorf("GeneratePassword(3) = %q, %v: ожидалась длина %d", short, err, MinPasswordLength)
	}
}
