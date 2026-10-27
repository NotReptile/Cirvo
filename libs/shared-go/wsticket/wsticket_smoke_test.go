//go:build smoke

package wsticket

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/NotReptile/Cirvo/libs/shared-go/redisstore"
)

func TestTicketIsSingleUse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := redisstore.ConnectFromEnv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	store := New(client.Client)
	want := Claims{Purpose: PurposeRealtime, UserID: uuid.New(), SessionID: uuid.New()}
	ticket, _, err := store.Issue(ctx, want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Consume(ctx, ticket, PurposeRealtime)
	if err != nil || got != want {
		t.Fatalf("consume = %+v, %v", got, err)
	}
	if _, err := store.Consume(ctx, ticket, PurposeRealtime); !errors.Is(err, ErrInvalid) {
		t.Fatalf("second consume error = %v, want ErrInvalid", err)
	}
}
