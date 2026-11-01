package hub

import (
	"context"
	"encoding/json"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/testdb"
	"testing"
	"time"
)

func tradeHarness(t *testing.T) (*Hub, *client, *client) {
	t.Helper()
	cat, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := db.Open(testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	h := &Hub{store: s, catalog: cat, ai: game.NewAI("http://127.0.0.1:1", cat), ctx: context.Background(), done: make(chan struct{}), events: make(chan any, 16), clients: map[int64]*client{}}
	cs := []*client{}
	for _, name := range []string{"alice", "boris"} {
		p, err := s.Register(h.ctx, name, "hash", "business", nil)
		if err != nil {
			t.Fatal(err)
		}
		// Dialogue and trade tests run at Lao Wang's central pavilion.
		p.X, p.Z = 100, 124
		c := &client{player: p, ctx: context.Background(), done: make(chan struct{}), send: make(chan []byte, 512), known: map[string]bool{}, expires: time.Now().Add(time.Hour)}
		h.clients[p.ID] = c
		cs = append(cs, c)
	}
	return h, cs[0], cs[1]
}
func data(v any) []byte { b, _ := json.Marshal(v); return b }
func packets(c *client) []Packet {
	out := []Packet{}
	for {
		select {
		case raw := <-c.send:
			var p Packet
			json.Unmarshal(raw, &p)
			out = append(out, p)
		default:
			return out
		}
	}
}
func requireError(t *testing.T, c *client, want string) {
	t.Helper()
	for _, p := range packets(c) {
		if p.Type == "ERROR" {
			var e struct {
				Code string `json:"code"`
			}
			json.Unmarshal(p.Payload, &e)
			if e.Code == want {
				return
			}
			t.Fatalf("got %s want %s", e.Code, want)
		}
	}
	t.Fatalf("missing error %s", want)
}
func completeTurn(t *testing.T, h *Hub, c *client, npc string, choice int) {
	t.Helper()
	v := map[string]any{"npc_id": npc}
	if choice != 0 {
		s, err := h.getScene(npc)
		if err != nil {
			t.Fatal(err)
		}
		v["choice_id"] = choice
		v["turn_id"] = turnID(s)
	}
	h.dialogue(c, data(v))
	if !c.pending {
		t.Fatalf("dialogue did not start: %+v", packets(c))
	}
	h.wg.Wait()
	deadline := time.After(2 * time.Second)
	for c.pending {
		select {
		case raw := <-h.events:
			if e, ok := raw.(aiDone); ok {
				h.finishDialogue(e)
			} else if p, ok := raw.(aiPartial); ok {
				h.partialDialogue(p)
			}
		case <-deadline:
			t.Fatal("missing result")
		}
	}
	for _, p := range packets(c) {
		if p.Type == "ERROR" {
			t.Fatalf("dialogue: %s", p.Payload)
		}
	}
	for _, other := range h.clients {
		if other != c {
			packets(other)
		}
	}
}
func openTrade(t *testing.T, h *Hub, c *client, npc, item string) *pendingTrade {
	t.Helper()
	h.tradeStart(c, data(map[string]any{"npc_id": npc, "item_id": item}))
	for _, p := range packets(c) {
		if p.Type == "ERROR" {
			t.Fatalf("open: %s", p.Payload)
		}
	}
	if c.trade == nil {
		t.Fatal("missing trade")
	}
	copy := *c.trade
	return &copy
}
func confirm(h *Hub, c *client, p *pendingTrade, amount any) {
	h.calculator(c, data(map[string]any{"npc_id": p.NPCID, "item_id": p.ItemID, "trade_id": p.ID, "amount": amount}))
}
func TestSharedAggroCanBeReducedByPartner(t *testing.T) {
	h, a, b := tradeHarness(t)
	completeTurn(t, h, a, "lao_wang", 0)
	for i := 0; i < 4; i++ {
		completeTurn(t, h, a, "lao_wang", 3)
	}
	s, _ := h.getScene("lao_wang")
	if s.data.State != "AGGRO" || s.data.Aggro != 100 {
		t.Fatalf("aggro: %+v", s.data)
	}
	h.tradeStart(a, data(map[string]any{"npc_id": "lao_wang", "item_id": "jade_amulet"}))
	requireError(t, a, "NPC_AGGRO")
	completeTurn(t, h, b, "lao_wang", 1)
	completeTurn(t, h, b, "lao_wang", 1)
	if s.data.Aggro != 70 || s.data.State == "AGGRO" {
		t.Fatalf("partner failed to calm NPC: %+v", s.data)
	}
	openTrade(t, h, b, "lao_wang", "jade_amulet")
	pa, _ := h.store.Player(h.ctx, a.player.ID)
	pb, _ := h.store.Player(h.ctx, b.player.ID)
	if pa.Balance != 500 || pb.Balance != 500 {
		t.Fatal("dialogue changed wallets")
	}
	ra, _ := h.store.Relation(h.ctx, a.player.ID, "lao_wang", 800, 120)
	rb, _ := h.store.Relation(h.ctx, b.player.ID, "lao_wang", 800, 120)
	if len(ra.History) != 6 || len(rb.History) != 4 {
		t.Fatal("personal histories merged")
	}
}
func TestTradeFundsReplayAndNoStaleSpeechAfterLearning(t *testing.T) {
	h, a, b := tradeHarness(t)
	completeTurn(t, h, a, "lao_wang", 0)
	p := openTrade(t, h, a, "lao_wang", "jade_amulet")
	confirm(h, a, p, 501)
	requireError(t, a, "INSUFFICIENT_FUNDS")
	if a.trade == nil {
		t.Fatal("funds error consumed offer")
	}
	confirm(h, a, p, 150)
	packets(a)
	packets(b)
	pa, _ := h.store.Player(h.ctx, a.player.ID)
	pb, _ := h.store.Player(h.ctx, b.player.ID)
	if pa.Balance != 350 || pb.Balance != 500 || a.speech != nil || b.speech != nil {
		t.Fatal("partner charged or stale speech retained")
	}
	confirm(h, a, p, 150)
	replayed := false
	for _, v := range packets(a) {
		if v.Type == "TRADE_RESULT" {
			var r struct {
				Replayed bool `json:"replayed"`
			}
			json.Unmarshal(v.Payload, &r)
			replayed = r.Replayed
		}
	}
	if !replayed {
		t.Fatal("receipt was not replayed")
	}
	confirm(h, a, p, 151)
	requireError(t, a, "INVALID_TRADE")
	confirm(h, b, p, 150)
	requireError(t, b, "STALE_TRADE")
	h.inspect(a, data(map[string]any{"item_id": "teapot"}))
	packets(a)
	quiz := a.quiz
	h.inspect(a, data(map[string]any{"item_id": "teapot", "answer_id": 1, "quiz_id": quiz}))
	for _, v := range packets(a) {
		if v.Type == "NPC_SPEECH" {
			t.Fatal("quiz resent old purchase turn")
		}
	}
	h.tradeStart(a, data(map[string]any{"npc_id": "lao_wang", "item_id": "jade_amulet"}))
	requireError(t, a, "ITEM_ALREADY_OWNED")
}
func TestTradeValidationAndVersioning(t *testing.T) {
	for _, mode := range []string{"expired", "foreign", "changed", "too_low", "fraction", "negative", "distant", "guard"} {
		t.Run(mode, func(t *testing.T) {
			h, a, b := tradeHarness(t)
			completeTurn(t, h, a, "lao_wang", 0)
			p := openTrade(t, h, a, "lao_wang", "jade_amulet")
			switch mode {
			case "expired":
				a.trade.Expires = time.Now().Add(-time.Second)
				confirm(h, a, p, 150)
				requireError(t, a, "TRADE_EXPIRED")
			case "foreign":
				confirm(h, b, p, 150)
				requireError(t, b, "STALE_TRADE")
			case "changed":
				completeTurn(t, h, b, "lao_wang", 1)
				confirm(h, a, p, 150)
				requireError(t, a, "STALE_TRADE")
			case "too_low":
				confirm(h, a, p, 119)
				rejected := false
				for _, v := range packets(a) {
					if v.Type == "TRADE_RESULT" {
						var r struct {
							Status string `json:"status"`
						}
						json.Unmarshal(v.Payload, &r)
						rejected = r.Status == "rejected"
					}
				}
				s, _ := h.getScene("lao_wang")
				if !rejected || s.data.Aggro != 25 || a.trade != nil {
					t.Fatal("low offer not rejected")
				}
			case "fraction":
				confirm(h, a, p, 150.5)
				requireError(t, a, "INVALID_TRADE")
			case "negative":
				confirm(h, a, p, -1)
				requireError(t, a, "INVALID_TRADE")
			case "distant":
				a.player.X = 170
				confirm(h, a, p, 150)
				requireError(t, a, "NPC_OUT_OF_RANGE")
			case "guard":
				h.tradeStart(a, data(map[string]any{"npc_id": "guard_zhang", "item_id": "jade_amulet"}))
				requireError(t, a, "INVALID_PRODUCT")
			}
			pa, _ := h.store.Player(h.ctx, a.player.ID)
			pb, _ := h.store.Player(h.ctx, b.player.ID)
			if pa.Balance != 500 || pb.Balance != 500 {
				t.Fatal("rejected trade changed wallets")
			}
		})
	}
}
func TestScenarioFallbacksAndGuardRules(t *testing.T) {
	h, a, _ := tradeHarness(t)
	a.player.X = 70
	a.player.Z = 110
	completeTurn(t, h, a, "chef_chen", 0)
	chef, _ := h.getScene("chef_chen")
	if chef.stored.Reply.Choices[0].Type != "order" || chef.data.Price != 150 {
		t.Fatal("chef lacks choices")
	}
	p := openTrade(t, h, a, "chef_chen", "noodles")
	confirm(h, a, p, 70)
	packets(a)
	items, _ := h.store.Inventory(h.ctx, a.player.ID)
	if len(items) != 1 || items[0].ID != "noodles" {
		t.Fatal("chef sale failed")
	}
	a.player.X = 150
	a.player.Z = 50
	completeTurn(t, h, a, "guard_zhang", 0)
	completeTurn(t, h, a, "guard_zhang", 3)
	guard, _ := h.getScene("guard_zhang")
	if guard.data.Aggro != 100 || guard.data.State != "AGGRO" || guard.stored.Reply.Emotion != "angry" {
		t.Fatalf("guard accepted bribe: %+v", guard.data)
	}
}

// The shared scene must not transfer a player's personal ban to another player.
func TestMerchantClosureIsPersonalAndPersists(t *testing.T) {
	h, a, b := tradeHarness(t)
	completeTurn(t, h, a, "lao_wang", 0)
	s, err := h.getScene("lao_wang")
	if err != nil {
		t.Fatal(err)
	}
	relation, err := h.store.Relation(h.ctx, a.player.ID, "lao_wang", 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		aggro  int
		closed bool
	}{{99, false}, {100, true}, {99, false}} {
		relation.Aggro = tc.aggro
		if err := h.store.SaveRelation(h.ctx, relation); err != nil {
			t.Fatal(err)
		}
		view := h.state(s, a)
		if view["personal_aggro"] != tc.aggro || view["stall_closed"] != tc.closed {
			t.Fatalf("personal state at %d: %+v", tc.aggro, view)
		}
		if h.state(s, b)["stall_closed"] != false {
			t.Fatal("other player was blocked")
		}
	}
	relation.Aggro = 100
	if err := h.store.SaveRelation(h.ctx, relation); err != nil {
		t.Fatal(err)
	}
	s.data.State, s.data.Aggro = "AGGRO", 100
	if _, err := h.store.SQL.ExecContext(h.ctx, "UPDATE npc_scenes SET state='AGGRO',aggro=100 WHERE npc_id='lao_wang'"); err != nil {
		t.Fatal(err)
	}
	h.tradeStart(a, data(map[string]any{"npc_id": "lao_wang", "item_id": "jade_amulet"}))
	requireError(t, a, "NPC_AGGRO")
	trade := openTrade(t, h, b, "lao_wang", "jade_amulet")
	confirm(h, b, trade, 150)
	if b.trade != nil {
		t.Fatal("unaffected player could not buy")
	}
	player, err := h.store.Player(h.ctx, b.player.ID)
	if err != nil || player.Balance != 350 {
		t.Fatalf("purchase: %+v %v", player, err)
	}
	delete(h.scenes, "lao_wang")
	s, err = h.getScene("lao_wang")
	if err != nil || h.state(s, a)["stall_closed"] != true {
		t.Fatal("closure lost after reload")
	}
	relation.Aggro = 75
	if err := h.store.SaveRelation(h.ctx, relation); err != nil {
		t.Fatal(err)
	}
	openTrade(t, h, a, "lao_wang", "jade_amulet")
}

func TestPendingTradeBlockedWhenPersonalAggroChanges(t *testing.T) {
	h, a, _ := tradeHarness(t)
	completeTurn(t, h, a, "lao_wang", 0)
	pending := openTrade(t, h, a, "lao_wang", "jade_amulet")
	relation, err := h.store.Relation(h.ctx, a.player.ID, "lao_wang", 800, 120)
	if err != nil {
		t.Fatal(err)
	}
	relation.Aggro = 100
	if err = h.store.SaveRelation(h.ctx, relation); err != nil {
		t.Fatal(err)
	}
	confirm(h, a, pending, 150)
	requireError(t, a, "NPC_AGGRO")
	if a.trade != nil {
		t.Fatal("blocked offer remains active")
	}
	if _, _, err = h.store.Buy(h.ctx, a.player.ID, "bypass", "lao_wang", "jade_amulet", 150, pending.Version); err != db.ErrTrade {
		t.Fatalf("transaction allowed blocked purchase: %v", err)
	}
	player, err := h.store.Player(h.ctx, a.player.ID)
	if err != nil || player.Balance != 500 {
		t.Fatalf("balance changed: %+v %v", player, err)
	}
}
