package handler

import (
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/hub"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type proposal struct {
	ID      string `json:"trade_id"`
	NPC     string `json:"npc_id"`
	Item    string `json:"item_id"`
	Version int64  `json:"scene_version"`
}

func openWS(t *testing.T, c *websocket.Conn) proposal {
	t.Helper()
	send(t, c, "TRADE_START", map[string]any{"npc_id": "lao_wang", "item_id": "jade_amulet"})
	var p proposal
	json.Unmarshal(until(t, c, "TRADE_OPEN"), &p)
	return p
}
func offer(p proposal) map[string]any {
	return map[string]any{"npc_id": p.NPC, "item_id": p.Item, "trade_id": p.ID, "amount": 150}
}
func outcome(t *testing.T, c *websocket.Conn) hub.Packet {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(4 * time.Second))
	for {
		var p hub.Packet
		if err := c.ReadJSON(&p); err != nil {
			t.Fatal(err)
		}
		if p.Type == "ERROR" || p.Type == "TRADE_RESULT" {
			return p
		}
	}
}
func speech(t *testing.T, c *websocket.Conn) hub.Speech {
	t.Helper()
	var s hub.Speech
	if err := json.Unmarshal(until(t, c, "NPC_SPEECH"), &s); err != nil {
		t.Fatal(err)
	}
	return s
}
func pair(t *testing.T, f *harness) (*websocket.Conn, *websocket.Conn, string, string) {
	t.Helper()
	ta := account(t, f, "alice", "business")
	tb := account(t, f, "boris", "culture")
	a := dial(t, f, ta)
	until(t, a, "WELCOME")
	until(t, a, "WORLD_STATS")
	b := dial(t, f, tb)
	until(t, b, "WELCOME")
	until(t, b, "WORLD_STATS")
	until(t, a, "PLAYER_JOIN")
	until(t, b, "PLAYER_JOIN")
	return a, b, ta, tb
}
func TestWSTradeRaceReplayReconnectAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "game.db")
	f := start(t, path, "http://127.0.0.1:1")
	a, b, ta, tb := pair(t, f)
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	sa, sb := speech(t, a), speech(t, b)
	if sa.TurnID == "" || sa.TurnID != sb.TurnID || len(sb.Choices) != 4 {
		t.Fatal("shared turn missing")
	}
	send(t, b, "DIALOGUE", map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": sb.TurnID})
	sa, sb = speech(t, a), speech(t, b)
	pa, pb := openWS(t, a), openWS(t, b)
	if pa.Version != pb.Version {
		t.Fatal("offers not on one version")
	}
	gate := make(chan struct{})
	errs := make(chan error, 2)
	for i, c := range []*websocket.Conn{a, b} {
		go func(i int, c *websocket.Conn) {
			<-gate
			p := []proposal{pa, pb}[i]
			errs <- c.WriteJSON(map[string]any{"type": "CALCULATOR", "payload": offer(p)})
		}(i, c)
	}
	close(gate)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	oa, ob := outcome(t, a), outcome(t, b)
	winner, loser := a, b
	wp, token, loserToken := pa, ta, tb
	winnerID, loserID := int64(1), int64(2)
	if oa.Type == "ERROR" {
		winner, loser = b, a
		wp, token, loserToken = pb, tb, ta
		winnerID, loserID = 2, 1
		oa, ob = ob, oa
	}
	if oa.Type != "TRADE_RESULT" || ob.Type != "ERROR" {
		t.Fatalf("race outcomes: %+v %+v", oa, ob)
	}
	var fail struct {
		Code string `json:"code"`
	}
	json.Unmarshal(ob.Payload, &fail)
	if fail.Code != "STALE_TRADE" {
		t.Fatalf("loser error: %s", ob.Payload)
	}
	send(t, winner, "CALCULATOR", offer(wp))
	result := outcome(t, winner)
	var receipt struct {
		Replayed bool `json:"replayed"`
	}
	json.Unmarshal(result.Payload, &receipt)
	if !receipt.Replayed {
		t.Fatal("WS replay charged twice")
	}
	send(t, loser, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	sw, sl := speech(t, winner), speech(t, loser)
	if sw.Price != 150 || sw.SceneVersion != sl.SceneVersion {
		t.Fatal("purchase did not update shared scene")
	}
	pending := openWS(t, loser)
	p, _ := f.store.Player(context.Background(), winnerID)
	q, _ := f.store.Player(context.Background(), loserID)
	if p.Balance != 350 || q.Balance != 500 {
		t.Fatalf("wallets are not personal: %d %d", p.Balance, q.Balance)
	}
	winner.Close()
	until(t, loser, "PLAYER_LEAVE")
	reconnect := dial(t, f, token)
	var reconnectWelcome struct {
		Player db.Player `json:"player"`
	}
	json.Unmarshal(until(t, reconnect, "WELCOME"), &reconnectWelcome)
	until(t, reconnect, "WORLD_STATS")
	reconnectSpeech := speech(t, reconnect)
	if reconnectWelcome.Player.Balance != 350 || reconnectSpeech.SceneVersion != sw.SceneVersion {
		t.Fatal("same-server reconnect lost state")
	}
	send(t, reconnect, "CALCULATOR", offer(wp))
	outcome(t, reconnect)
	f.close()
	f2 := start(t, path, "http://127.0.0.1:1")
	rw := dial(t, f2, token)
	var welcome struct {
		Player    db.Player `json:"player"`
		Inventory []db.Item `json:"inventory"`
	}
	json.Unmarshal(until(t, rw, "WELCOME"), &welcome)
	until(t, rw, "WORLD_STATS")
	restored := speech(t, rw)
	if welcome.Player.Balance != 350 || len(welcome.Inventory) != 1 || restored.Price != 150 || restored.SceneVersion != sw.SceneVersion {
		t.Fatal("restart lost purchase or shared conversation")
	}
	send(t, rw, "CALCULATOR", offer(wp))
	result = outcome(t, rw)
	json.Unmarshal(result.Payload, &receipt)
	if !receipt.Replayed {
		t.Fatal("restart replay failed")
	}
	rl := dial(t, f2, loserToken)
	until(t, rl, "WELCOME")
	until(t, rl, "WORLD_STATS")
	speech(t, rl)
	send(t, rl, "CALCULATOR", offer(pending))
	errorCode(t, rl, "STALE_TRADE")
	q, _ = f2.store.Player(context.Background(), loserID)
	if q.Balance != 500 {
		t.Fatal("unfinished proposal survived disconnect")
	}
}
func TestNPCSpatialRecipientsAndInteractionRadius(t *testing.T) {
	f := start(t, filepath.Join(t.TempDir(), "game.db"), "http://127.0.0.1:1")
	a, b, _, _ := pair(t, f)
	send(t, b, "MOVE", map[string]any{"x": 120, "z": 110, "rotation": 0})
	until(t, a, "PLAYER_MOVE")
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	sa, sb := speech(t, a), speech(t, b)
	if sa.TurnID == "" || sb.TurnID != "" || len(sb.Choices) != 0 {
		t.Fatal("spectator received interaction controls")
	}
	send(t, b, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	errorCode(t, b, "NPC_OUT_OF_RANGE")
	send(t, b, "MOVE", map[string]any{"x": 126, "z": 110, "rotation": 0})
	until(t, b, "NPC_LEAVE")
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": sa.TurnID})
	speech(t, a)
	send(t, b, "CHAT", map[string]any{"text": "spatial barrier"})
	b.SetReadDeadline(time.Now().Add(4 * time.Second))
	for {
		var p hub.Packet
		if err := b.ReadJSON(&p); err != nil {
			t.Fatal(err)
		}
		if p.Type == "NPC_SPEECH" {
			t.Fatal("NPC speech leaked beyond 15 units")
		}
		if p.Type == "CHAT" {
			break
		}
	}
	send(t, b, "MOVE", map[string]any{"x": 111, "z": 110, "rotation": 0})
	returned := speech(t, b)
	if returned.TurnID == "" || len(returned.Choices) != 4 {
		t.Fatal("returning participant did not receive active turn")
	}
}
func TestDisconnectCancelsAIAndReleasesSharedNPC(t *testing.T) {
	cat, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	started, cancelled := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		if requests.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			close(cancelled)
			return
		}
		reply := game.Fallback(db.Relation{NPCID: "lao_wang", State: "HAGGLING", Price: 800, Floor: 120, Mianzi: 50}, nil, cat)
		json.NewEncoder(w).Encode(map[string]any{"parsed": reply})
	}))
	t.Cleanup(ai.Close)
	f := start(t, filepath.Join(t.TempDir(), "game.db"), ai.URL)
	a, b, _, _ := pair(t, f)
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	until(t, a, "DIALOGUE_PENDING")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("AI not started")
	}
	send(t, b, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	errorCode(t, b, "DIALOGUE_BUSY")
	a.Close()
	var done struct {
		Status string `json:"status"`
	}
	json.Unmarshal(until(t, b, "DIALOGUE_DONE"), &done)
	if done.Status != "cancelled" {
		t.Fatal("missing cancellation notification")
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("disconnected AI request kept running")
	}
	send(t, b, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	s := speech(t, b)
	if s.Fallback || len(s.Choices) != 4 {
		t.Fatal("shared NPC remained locked")
	}
}
func TestSlowAIUsesFallbackWithinClientTimeout(t *testing.T) {
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	t.Cleanup(ai.Close)
	f := start(t, filepath.Join(t.TempDir(), "game.db"), ai.URL, func(a *game.AI) { a.Client.Timeout = 40 * time.Millisecond })
	c := dial(t, f, account(t, f, "alice", "business"))
	until(t, c, "WELCOME")
	until(t, c, "WORLD_STATS")
	send(t, c, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	s := speech(t, c)
	if !s.Fallback || len(s.Choices) != 4 {
		t.Fatal("slow AI did not trigger fallback")
	}
	var done struct {
		Status string `json:"status"`
	}
	json.Unmarshal(until(t, c, "DIALOGUE_DONE"), &done)
	if done.Status != "completed" {
		t.Fatal("fallback left spinner busy")
	}
}
