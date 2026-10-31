package db

import (
	"context"
	"database/sql"
	"errors"
	"hackaton/server/internal/testdb"
	"sync"
	"testing"
)

func tradeStore(t *testing.T) (*Store, string, Player, Player) {
	t.Helper()
	path := testdb.New(t)
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	a, err := s.Register(context.Background(), "alice", "hash", "business", nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Register(context.Background(), "boris", "hash", "culture", nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, path, a, b
}
func readyScene(t *testing.T, s *Store, player int64, npc string) Scene {
	t.Helper()
	ctx := context.Background()
	scene, err := s.Scene(ctx, npc, 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	personal, err := s.Relation(ctx, player, npc, 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	scene.State = "HAGGLING"
	personal.State = "HAGGLING"
	v, err := s.CommitScene(ctx, scene, personal, []byte("null"))
	if err != nil {
		t.Fatal(err)
	}
	scene.Version = v
	return scene
}
func TestPurchaseReplayAndRestart(t *testing.T) {
	s, path, a, b := tradeStore(t)
	ctx := context.Background()
	scene := readyScene(t, s, a.ID, "lao_wang")
	receipt, replay, err := s.Buy(ctx, a.ID, "trade-1", "lao_wang", "jade_amulet", 150, scene.Version)
	if err != nil || replay || receipt.BalanceAfter != 350 {
		t.Fatalf("purchase: %+v %v %v", receipt, replay, err)
	}
	same, replay, err := s.Buy(ctx, a.ID, "trade-1", "lao_wang", "jade_amulet", 150, scene.Version)
	if err != nil || !replay || same != receipt {
		t.Fatalf("replay: %+v %v %v", same, replay, err)
	}
	if _, _, err = s.Buy(ctx, a.ID, "trade-1", "lao_wang", "jade_amulet", 151, scene.Version); !errors.Is(err, ErrTrade) {
		t.Fatalf("altered replay: %v", err)
	}
	if _, _, err = s.Buy(ctx, b.ID, "trade-1", "lao_wang", "jade_amulet", 150, scene.Version); !errors.Is(err, ErrTrade) {
		t.Fatalf("foreign replay: %v", err)
	}
	if _, err = s.Receipt(ctx, b.ID, "trade-1"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("foreign receipt: %v", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	same, replay, err = reopened.Buy(ctx, a.ID, "trade-1", "lao_wang", "jade_amulet", 150, 0)
	if err != nil || !replay || same != receipt {
		t.Fatalf("restart replay: %+v %v %v", same, replay, err)
	}
	p, err := reopened.Player(ctx, a.ID)
	if err != nil || p.Balance != 350 {
		t.Fatalf("replay changed balance: %+v %v", p, err)
	}
	inventory, err := reopened.Inventory(ctx, a.ID)
	if err != nil || len(inventory) != 1 {
		t.Fatalf("inventory: %+v %v", inventory, err)
	}
	saved, err := reopened.Scene(ctx, "lao_wang", 999, 120)
	if err != nil || saved.Price != 150 || saved.Version != scene.Version+1 {
		t.Fatalf("shared scene lost: %+v %v", saved, err)
	}
	if _, _, err = reopened.Buy(ctx, a.ID, "trade-2", "lao_wang", "jade_amulet", 150, saved.Version); !errors.Is(err, ErrOwned) {
		t.Fatalf("duplicate item: %v", err)
	}
}
func TestPurchaseRollsBackAfterDebit(t *testing.T) {
	s, _, a, _ := tradeStore(t)
	ctx := context.Background()
	scene := readyScene(t, s, a.ID, "lao_wang")
	if _, err := s.SQL.Exec("CREATE FUNCTION fail_inventory_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated write failure'; END $$; CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory FOR EACH ROW EXECUTE FUNCTION fail_inventory_fn()"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Buy(ctx, a.ID, "broken", "lao_wang", "jade_amulet", 150, scene.Version); err == nil {
		t.Fatal("write failure was ignored")
	}
	p, _ := s.Player(ctx, a.ID)
	items, _ := s.Inventory(ctx, a.ID)
	saved, _ := s.Scene(ctx, "lao_wang", 800, 120)
	if p.Balance != 500 || len(items) != 0 || saved.Version != scene.Version || saved.Price != 800 {
		t.Fatalf("partial purchase: %+v %+v %+v", p, items, saved)
	}
	if _, err := s.Receipt(ctx, a.ID, "broken"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("failed purchase left receipt: %v", err)
	}
}
func TestConcurrentPurchasesShareVersion(t *testing.T) {
	s, _, a, b := tradeStore(t)
	ctx := context.Background()
	scene := readyScene(t, s, a.ID, "lao_wang")
	gate := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i, p := range []Player{a, b} {
		wg.Add(1)
		go func(index int, p Player) {
			defer wg.Done()
			<-gate
			_, _, err := s.Buy(ctx, p.ID, []string{"a", "b"}[index], "lao_wang", "jade_amulet", 150, scene.Version)
			results <- err
		}(i, p)
	}
	close(gate)
	wg.Wait()
	close(results)
	ok, stale := 0, 0
	for err := range results {
		if err == nil {
			ok++
		} else if errors.Is(err, ErrStale) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if ok != 1 || stale != 1 {
		t.Fatalf("success=%d stale=%d", ok, stale)
	}
	pa, _ := s.Player(ctx, a.ID)
	pb, _ := s.Player(ctx, b.ID)
	if pa.Balance+pb.Balance != 850 {
		t.Fatalf("wrong combined balance: %d %d", pa.Balance, pb.Balance)
	}
}
func TestConcurrentPurchasesCannotOverdrawPersonalWallet(t *testing.T) {
	s, _, a, _ := tradeStore(t)
	ctx := context.Background()
	one := readyScene(t, s, a.ID, "lao_wang")
	two := readyScene(t, s, a.ID, "chef_chen")
	gate := make(chan struct{})
	results := make(chan error, 2)
	for i, scene := range []Scene{one, two} {
		go func(index int, sc Scene) {
			<-gate
			_, _, err := s.Buy(ctx, a.ID, []string{"one", "two"}[index], sc.NPCID, []string{"jade_amulet", "noodles"}[index], 300, sc.Version)
			results <- err
		}(i, scene)
	}
	close(gate)
	ok, funds := 0, 0
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			ok++
		} else if errors.Is(err, ErrFunds) {
			funds++
		} else {
			t.Fatal(err)
		}
	}
	p, _ := s.Player(ctx, a.ID)
	items, _ := s.Inventory(ctx, a.ID)
	if ok != 1 || funds != 1 || p.Balance != 200 || len(items) != 1 {
		t.Fatalf("overdraw: ok=%d funds=%d balance=%d items=%v", ok, funds, p.Balance, items)
	}
}
func TestUpgradeFromStageFourPreservesProgress(t *testing.T) {
	path := testdb.New(t)
	raw, err := sql.Open("pgx", path)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := migrations.ReadFile("migrations/001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = raw.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	if _, err = raw.Exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);INSERT INTO schema_migrations(version) VALUES(1);INSERT INTO players(login,password_hash,profile,balance) VALUES('legacy','hash','culture',320);INSERT INTO known_words(player_id,word_id) VALUES(1,'word_teapot');INSERT INTO inventory(player_id,item_id,price_paid) VALUES(1,'legacy_item',180);INSERT INTO npc_relations(npc_id,player_id,current_price,price_floor,aggro) VALUES('lao_wang',1,640,120,25)"); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p, _ := s.Player(context.Background(), 1)
	items, _ := s.Inventory(context.Background(), 1)
	words, _ := s.Words(context.Background(), 1)
	personal, _ := s.Relation(context.Background(), 1, "lao_wang", 800, 120)
	scene, _ := s.Scene(context.Background(), "lao_wang", 800, 120)
	if p.Balance != 320 || len(items) != 1 || len(words) != 1 || personal.Aggro != 25 || scene.Aggro != 0 || scene.Price != 800 {
		t.Fatalf("upgrade changed progress: %+v %+v %+v %+v %+v", p, items, words, personal, scene)
	}
}

func TestSharedSceneCanReplaceLegacyPersonalPriceFloor(t *testing.T) {
	s, _, a, _ := tradeStore(t)
	ctx := context.Background()
	old, err := s.Relation(ctx, a.ID, "lao_wang", 999, 999)
	if err != nil {
		t.Fatal(err)
	}
	scene, err := s.Scene(ctx, "lao_wang", 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	scene.State = "HAGGLING"
	scene.Price = 700
	personal := scene.Relation
	personal.PlayerID = a.ID
	personal.History = old.History
	if _, err = s.CommitScene(ctx, scene, personal, []byte("null")); err != nil {
		t.Fatalf("legacy floor blocked shared scene: %v", err)
	}
	saved, err := s.Relation(ctx, a.ID, "lao_wang", 800, 120)
	if err != nil || saved.Floor != 120 || saved.Price != 700 {
		t.Fatalf("inconsistent personal snapshot: %+v %v", saved, err)
	}
}

func TestConcurrentIdenticalPurchaseReturnsOneReceipt(t *testing.T) {
	s, _, a, _ := tradeStore(t)
	ctx := context.Background()
	scene := readyScene(t, s, a.ID, "lao_wang")
	gate := make(chan struct{})
	type result struct {
		receipt Receipt
		replay  bool
		err     error
	}
	results := make(chan result, 6)
	for i := 0; i < 6; i++ {
		go func() {
			<-gate
			r, replayed, err := s.Buy(ctx, a.ID, "same-request", "lao_wang", "jade_amulet", 150, scene.Version)
			results <- result{r, replayed, err}
		}()
	}
	close(gate)
	fresh := 0
	for i := 0; i < 6; i++ {
		r := <-results
		if r.err != nil {
			t.Fatal(r.err)
		}
		if !r.replay {
			fresh++
		}
		if r.receipt.BalanceAfter != 350 {
			t.Fatal("inconsistent receipt")
		}
	}
	p, err := s.Player(ctx, a.ID)
	if err != nil || fresh != 1 || p.Balance != 350 {
		t.Fatalf("duplicate charge: fresh=%d player=%+v err=%v", fresh, p, err)
	}
}
func TestConcurrentServerMigrationsAreSerialized(t *testing.T) {
	dsn := testdb.New(t)
	results := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			s, err := Open(dsn)
			if err == nil {
				defer s.Close()
				var n int
				err = s.SQL.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n)
				if err == nil && n != 2 {
					err = errors.New("migration count changed")
				}
			}
			results <- err
		}()
	}
	for i := 0; i < 3; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}
