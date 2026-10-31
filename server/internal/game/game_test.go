package game

import (
	"context"
	"encoding/json"
	"hackaton/server/internal/db"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	c, err := LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func TestAOIBoundariesAndBudget(t *testing.T) {
	c := testCatalog(t)
	w, err := LoadWorld("../../world/chunks", c)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		x, z float64
		n    int
	}{{110, 110, 9}, {0, 0, 4}, {199.9, 0, 4}, {0, 100, 6}, {199.9, 199.9, 4}} {
		ids := w.AOI(tc.x, tc.z)
		if len(ids) != tc.n {
			t.Fatalf("AOI(%v,%v): %v", tc.x, tc.z, ids)
		}
		if ids[0] != ChunkID(tc.x, tc.z) {
			t.Fatal("current chunk missing")
		}
		total := 0
		for _, id := range ids {
			total += w.Sizes[id]
		}
		if total*10 > w.TotalBytes {
			t.Fatal("budget exceeded")
		}
	}
	if len(w.AOI(-1, 10)) != 0 || len(w.AOI(200, 10)) != 0 {
		t.Fatal("outside world accepted")
	}
	// An unequal world must trim neighbors, not claim 9 chunks always means 9%.
	w.Sizes["5_5"] = w.TotalBytes / 12
	ids := w.AOI(110, 110)
	total := 0
	for _, id := range ids {
		total += w.Sizes[id]
	}
	if len(ids) >= 9 || ids[0] != "5_5" || total*10 > w.TotalBytes {
		t.Fatalf("unequal budget: %v", ids)
	}
}
func TestPersonalVocabularyAndFSM(t *testing.T) {
	c := testCatalog(t)
	tokens := []Token{c.Words["word_expensive"], c.Words["word_jade"]}
	a := Filter(tokens, map[string]bool{"word_expensive": true})
	b := Filter(tokens, map[string]bool{"word_jade": true})
	if a[0].RU == "[???]" || a[1].RU != "[???]" || b[0].RU != "[???]" || b[1].RU == "[???]" || tokens[0].RU == "[???]" {
		t.Fatal("filter leaked or modified tokens")
	}
	r := db.Relation{State: "IDLE", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	choices := Choices()
	for i := 0; i < 4; i++ {
		p := Fallback(r, &choices[2], c)
		r = AppendHistory(Apply(r, p), "provoke", p)
	}
	if r.State != "AGGRO" || r.Aggro != 100 || len(r.History) != 6 || r.Floor != 120 {
		t.Fatalf("bad FSM %+v", r)
	}
	for i := 0; i < 6; i++ {
		p := Fallback(r, &choices[0], c)
		r = Apply(r, p)
	}
	if r.State != "FLATTERED" || r.Aggro > 75 || r.Mianzi != 100 || r.Price < 120 {
		t.Fatalf("recovery failed %+v", r)
	}
}
func TestAIContractFailuresAndCancellation(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "lao_wang", Price: 800, Floor: 120, Mianzi: 50, History: []db.Message{}}
	valid := Fallback(r, nil, c)
	for _, mode := range []string{"ok", "malformed", "missing", "floor", "choices", "word", "http"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path != "/dialogue" {
					t.Error("wrong AI path")
				}
				var body struct {
					NPCID   string         `json:"npc_id"`
					Context map[string]any `json:"context"`
				}
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.NPCID != "lao_wang" || body.Context["price_floor"] != float64(120) {
					t.Error("invalid context")
				}
				p := valid
				switch mode {
				case "malformed":
					w.Write([]byte("not json"))
					return
				case "missing":
					w.Write([]byte("{\"parsed\":{}}"))
					return
				case "floor":
					p.Price = 119
				case "choices":
					p.Choices = Choices()[:3]
				case "word":
					p.Tokens = []Token{{ID: "invented", ZH: "x", PY: "x", RU: "x"}}
				case "http":
					w.WriteHeader(503)
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"raw": "", "parsed": p})
			}))
			defer server.Close()
			_, err := NewAI(server.URL, c).Request(context.Background(), r, "hello")
			if (err == nil) != (mode == "ok") {
				t.Fatalf("mode %s err=%v", mode, err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := NewAI(server.URL, c).Request(ctx, r, "hello"); err == nil {
		t.Fatal("timeout ignored")
	}
}

func TestGuardRuleOverridesModelResponse(t *testing.T) {
	c := testCatalog(t)
	r := db.Relation{NPCID: "guard_zhang", Price: 0, Floor: 0, Mianzi: 50, State: "HAGGLING"}
	model := Reply{Price: 0, Emotion: "happy", AggroDelta: -20, MianziDelta: 30, State: "HAGGLING", Choices: ChoicesFor("guard")}
	reply := Enforce(model, r, &Choice{Type: "bribe"}, c.NPCs["guard_zhang"])
	state := Apply(r, reply)
	if state.Aggro != 100 || state.State != "AGGRO" || reply.Emotion != "angry" {
		t.Fatal("model overrode server bribe rule")
	}
}
