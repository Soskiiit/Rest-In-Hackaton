// Package testdb creates disposable schemas exclusively in hackaton_test.
package testdb

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"net/url"
	"os"
	"testing"
	"time"
)

func New(t testing.TB) string {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Path != "/hackaton_test" {
		t.Fatal("TEST_DATABASE_URL must point to the dedicated hackaton_test database; see server/README.md")
	}
	admin, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err = admin.PingContext(ctx); err != nil {
		admin.Close()
		t.Fatal("PostgreSQL test database unavailable; start docker compose up -d --wait db")
	}
	name := fmt.Sprintf("test_%x", []byte(rand.Text())[:12])
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err = admin.ExecContext(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Errorf("cleanup test schema: %v", err)
		}
		admin.Close()
	})
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	return u.String()
}
