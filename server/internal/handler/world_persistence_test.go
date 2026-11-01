package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/hub"
	"hackaton/server/internal/testdb"
)

func TestPersistentWorldAPI(t *testing.T) {
	ctx := context.Background()
	store, err := db.Open(testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	catalog, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	initial, err := game.LoadWorld("../../world/chunks", catalog)
	if err != nil {
		t.Fatal(err)
	}
	seed := map[string]json.RawMessage{}
	for id, chunk := range initial.Chunks {
		seed[id], _ = json.Marshal(chunk)
	}
	saved, err := store.LoadWorld(ctx, seed)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]json.RawMessage{}
	for id, chunk := range saved {
		data[id] = chunk.Data
	}
	world, err := initial.Updated(data, catalog)
	if err != nil {
		t.Fatal(err)
	}
	for id, chunk := range saved {
		world.Revisions[id] = chunk.Revision
	}
	h := hub.New(store, world, catalog, game.NewAI("http://127.0.0.1:1", catalog))
	defer h.Close()
	app, err := New(store, h, catalog, testSecret, []string{"http://localhost:5173"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	player, err := store.Register(ctx, "worldtest", "hash", "business", nil)
	if err != nil {
		t.Fatal(err)
	}
	token, err := app.Token(player.ID, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	player2, err := store.Register(ctx, "worldtest2", "hash", "business", nil)
	if err != nil {
		t.Fatal(err)
	}
	token2, err := app.Token(player2.ID, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	f := &harness{http: server}
	a := dial(t, f, token)
	b := dial(t, f, token2)
	until(t, a, "WELCOME")
	until(t, b, "WELCOME")
	until(t, a, "PLAYER_JOIN")
	until(t, b, "PLAYER_JOIN")
	send := func(method string, body any, auth bool) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/world/chunks", bytes.NewReader(payload))
		if auth {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, req)
		return rec
	}
	if got := send("GET", nil, false).Code; got != http.StatusUnauthorized {
		t.Fatalf("unauthorized: %d", got)
	}
	chunk := world.Chunks["5_6"]
	chunk.NPCs = []game.NPCRef{{ID: "lao_wang", X: 10, Z: 10}}
	for i := range chunk.Items {
		if chunk.Items[i].ID == "teapot" {
			chunk.Items[i].X = 11
			chunk.Items[i].Z = 10
		}
	}
	raw, _ := json.Marshal(chunk)
	edit := map[string]db.WorldChunk{"5_6": {Data: raw, Revision: 1}}
	if r := send("POST", map[string]any{"chunks": edit}, true); r.Code != 200 {
		t.Fatalf("save: %d %s", r.Code, r.Body)
	}
	for _, conn := range []*websocket.Conn{a, b} {
		found := false
		for i := 0; i < 30; i++ {
			var packet hub.Packet
			if err := conn.ReadJSON(&packet); err != nil {
				t.Fatal(err)
			}
			if packet.Type != "CHUNK_LOAD" {
				continue
			}
			var chunk struct {
				ID       string `json:"chunk_id"`
				Revision int64  `json:"revision"`
			}
			if err := json.Unmarshal(packet.Payload, &chunk); err != nil {
				t.Fatal(err)
			}
			if chunk.ID == "5_6" && chunk.Revision == 2 {
				found = true
				break
			}
		}
		if !found {
			t.Fatal("updated chunk was not sent to player")
		}
	}
	state, err := h.World(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if state["5_6"].Revision != 2 {
		t.Fatalf("revision %d", state["5_6"].Revision)
	}
	move(t, a, 110, 129, 0)
	if err := a.WriteJSON(map[string]any{"type": "DIALOGUE", "payload": map[string]any{"npc_id": "lao_wang"}}); err != nil {
		t.Fatal(err)
	}
	until(t, a, "DIALOGUE_PENDING")
	if err := a.WriteJSON(map[string]any{"type": "INSPECT", "payload": map[string]any{"item_id": "teapot"}}); err != nil {
		t.Fatal(err)
	}
	until(t, a, "QUIZ")

	if r := send("POST", map[string]any{"chunks": edit}, true); r.Code != 409 {
		t.Fatalf("conflict: %d", r.Code)
	}
	bad := map[string]db.WorldChunk{"5_6": {Data: json.RawMessage(`{"chunk_id":"5_6"}`), Revision: 2}}
	if r := send("POST", map[string]any{"chunks": bad}, true); r.Code != 400 {
		t.Fatalf("invalid: %d", r.Code)
	}
	restored, err := store.LoadWorld(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if restored["5_6"].Revision != 2 {
		t.Fatal("saved revision did not survive reload")
	}
	restoredData := map[string]json.RawMessage{}
	for id, entry := range restored {
		restoredData[id] = entry.Data
	}
	if _, err := game.LoadWorldData("/not/a/real/world", restoredData, catalog); err != nil {
		t.Fatalf("restoring world depended on chunk files: %v", err)
	}

	var loaded game.Chunk
	if err := json.Unmarshal(restored["5_6"].Data, &loaded); err != nil || len(loaded.NPCs) != 1 || loaded.NPCs[0].X != 10 {
		t.Fatalf("saved chunk: %+v %v", loaded, err)
	}
}
