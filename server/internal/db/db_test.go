package db

import (
	"context"
	"database/sql"
	"hackaton/server/internal/testdb"
	"testing"
)

func TestPersistenceConstraintsAndTransactions(t *testing.T) {
	ctx := context.Background()
	path := testdb.New(t)
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	p, err := s.Register(ctx, " alice ", "hashed-password", "business", []string{"word_one"})
	if err != nil {
		t.Fatal(err)
	}
	if p.Login != "alice" || p.Balance != 500 || p.X != 110 {
		t.Fatalf("bad defaults: %+v", p)
	}
	if _, err = s.Register(ctx, "alice", "hash", "culture", nil); err != ErrLoginTaken {
		t.Fatalf("duplicate login: %v", err)
	}
	if _, err = s.Register(ctx, "rollback", "hash", "business", []string{"word_one", ""}); err == nil {
		t.Fatal("expected starter word failure")
	}
	if _, err = s.ByLogin(ctx, "rollback"); err == nil {
		t.Fatal("registration was not rolled back")
	}
	for _, q := range []string{
		"INSERT INTO known_words(player_id,word_id) VALUES(999,'missing')",
		"UPDATE players SET balance=-1",
		"UPDATE players SET profile='invalid'",
		"UPDATE players SET pos_x=200",
	} {
		if _, err = s.SQL.Exec(q); err == nil {
			t.Fatalf("constraint allowed %s", q)
		}
	}
	if learned, err := s.Learn(ctx, p.ID, "word_teapot"); err != nil || !learned {
		t.Fatalf("learn: %v %v", learned, err)
	}
	if learned, err := s.Learn(ctx, p.ID, "word_teapot"); err != nil || learned {
		t.Fatalf("duplicate learn: %v %v", learned, err)
	}
	r, err := s.Relation(ctx, p.ID, "lao_wang", 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	if r.Mianzi != 50 || r.Aggro != 0 || r.State != "IDLE" || r.Price != 800 || r.Floor != 120 {
		t.Fatalf("bad relation: %+v", r)
	}
	if _, err = s.SQL.Exec("UPDATE npc_relations SET aggro=101"); err == nil {
		t.Fatal("invalid aggro allowed")
	}
	if _, err = s.SQL.Exec("UPDATE npc_relations SET state='INVALID'"); err == nil {
		t.Fatal("invalid state allowed")
	}
	if _, err = s.SQL.Exec("UPDATE npc_relations SET current_price=119"); err == nil {
		t.Fatal("price below floor allowed")
	}
	r.Aggro = 25
	r.Price = 640
	r.History = []Message{{Role: "assistant", Content: "remembered"}}
	if err = s.SaveRelation(ctx, r); err != nil {
		t.Fatal(err)
	}
	p.X = 113
	p.Z = 115
	p.Rotation = 1.5
	if err = s.SavePositions(ctx, []Player{p}); err != nil {
		t.Fatal(err)
	}
	for pragma, want := range map[string]string{"statement_timeout": "10s", "lock_timeout": "5s", "application_name": "rest-in-hackaton"} {
		var got string
		if err = s.SQL.QueryRow("SHOW " + pragma).Scan(&got); err != nil || got != want {
			t.Fatalf("%s=%s err=%v", pragma, got, err)
		}
	}
	if _, err = s.SQL.Exec("UPDATE players SET balance=320 WHERE id=$1", p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SQL.Exec("INSERT INTO inventory(player_id,item_id,price_paid) VALUES($1,$2,$3)", p.ID, "teapot", 180); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := s.Player(ctx, p.ID)
	if err != nil || saved.X != 113 || saved.Z != 115 || saved.Rotation != 1.5 || saved.Balance != 320 {
		t.Fatalf("saved player: %+v %v", saved, err)
	}
	words, err := s.Words(ctx, p.ID)
	if err != nil || len(words) != 2 {
		t.Fatalf("saved words: %v %v", words, err)
	}
	r, err = s.Relation(ctx, p.ID, "lao_wang", 999, 999)
	if err != nil || r.Price != 640 || r.Floor != 120 || r.Aggro != 25 || len(r.History) != 1 {
		t.Fatalf("saved relation: %+v %v", r, err)
	}
	var n int
	if err = s.SQL.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n); err != nil || n != 2 {
		t.Fatalf("migrations: %d %v", n, err)
	}
	inventory, err := s.Inventory(ctx, p.ID)
	if err != nil || len(inventory) != 1 || inventory[0].ID != "teapot" || inventory[0].PricePaid != 180 {
		t.Fatalf("saved inventory: %+v %v", inventory, err)
	}
	if _, err = s.SQL.Exec("DELETE FROM players WHERE id=$1", p.ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"known_words", "npc_relations", "inventory"} {
		if err = s.SQL.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("cascade %s: %d %v", table, n, err)
		}
	}
}

func TestMigrationFailureRollsBackSchema(t *testing.T) {
	path := testdb.New(t)
	raw, err := sql.Open("pgx", path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err = raw.Exec("CREATE TABLE known_words(legacy_value TEXT)"); err != nil {
		t.Fatal(err)
	}
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("conflicting schema was accepted")
	}
	var count int
	if err = raw.QueryRow("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('players','schema_migrations')").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed migration left a partial schema: %d %v", count, err)
	}
}
