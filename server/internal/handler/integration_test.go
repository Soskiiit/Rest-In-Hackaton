package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"hackaton/server/internal/hub"
)

const testSecret = "test-only-secret-at-least-32-characters"

type harness struct {
	app   *App
	http  *httptest.Server
	store *db.Store
	close func()
}

func start(t *testing.T, path, aiURL string, options ...func(*game.AI)) *harness {
	t.Helper()
	c, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	w, err := game.LoadWorld("../../world/chunks", c)
	if err != nil {
		t.Fatal(err)
	}
	s, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ai := game.NewAI(aiURL, c)
	for _, option := range options {
		option(ai)
	}
	h := hub.New(s, w, c, ai)
	a, err := New(s, h, c, testSecret, []string{"http://localhost:5173"})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(a.Handler())
	var once sync.Once
	f := &harness{app: a, http: ts, store: s}
	f.close = func() { once.Do(func() { h.Close(); ts.Close(); s.Close() }) }
	t.Cleanup(f.close)
	return f
}
func post(t *testing.T, f *harness, path string, body any, status int) map[string]json.RawMessage {
	t.Helper()
	b, _ := json.Marshal(body)
	res, err := http.Post(f.http.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]json.RawMessage
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != status {
		t.Fatalf("%s status=%d body=%s", path, res.StatusCode, out)
	}
	return out
}
func account(t *testing.T, f *harness, name, profile string) string {
	t.Helper()
	out := post(t, f, "/auth/register", map[string]string{"login": name, "password": "password123", "profile": profile}, 201)
	var token string
	json.Unmarshal(out["token"], &token)
	return token
}
func dial(t *testing.T, f *harness, token string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/ws?token="+token, http.Header{"Origin": []string{"http://localhost:5173"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}
func send(t *testing.T, c *websocket.Conn, kind string, payload any) {
	t.Helper()
	if err := c.WriteJSON(map[string]any{"type": kind, "payload": payload}); err != nil {
		t.Fatal(err)
	}
}
func until(t *testing.T, c *websocket.Conn, kind string) json.RawMessage {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(4 * time.Second))
	for {
		var p hub.Packet
		if err := c.ReadJSON(&p); err != nil {
			t.Fatalf("waiting %s: %v", kind, err)
		}
		if p.Type == kind {
			return p.Payload
		}
		if p.Type == "ERROR" && kind != "ERROR" {
			t.Fatalf("unexpected error waiting %s: %s", kind, p.Payload)
		}
	}
}
func errorCode(t *testing.T, c *websocket.Conn, want string) {
	t.Helper()
	var v struct {
		Code string `json:"code"`
	}
	json.Unmarshal(until(t, c, "ERROR"), &v)
	if v.Code != want {
		t.Fatalf("error=%s want=%s", v.Code, want)
	}
}
func TestAuthAndOrigin(t *testing.T) {
	f := start(t, filepath.Join(t.TempDir(), "game.db"), "http://127.0.0.1:1")
	token := account(t, f, " alice ", "business")
	post(t, f, "/auth/register", map[string]string{"login": "alice", "password": "password123"}, 409)
	post(t, f, "/auth/login", map[string]string{"login": "alice", "password": "incorrect"}, 401)
	post(t, f, "/auth/login", map[string]string{"login": "missing", "password": "password123"}, 401)
	out := post(t, f, "/auth/login", map[string]string{"login": " alice ", "password": "password123"}, 200)
	if bytes.Contains(out["player"], []byte("password")) {
		t.Fatal("password leaked")
	}
	p, err := f.store.ByLogin(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if p.PasswordHash == "password123" || bcrypt.CompareHashAndPassword([]byte(p.PasswordHash), []byte("password123")) != nil {
		t.Fatal("password not hashed")
	}
	expired, err := f.app.Token(p.ID, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "bad", expired} {
		conn, res, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/ws?token="+bad, nil)
		if conn != nil {
			conn.Close()
		}
		if err == nil || res == nil || res.StatusCode != 401 {
			t.Fatalf("bad token accepted: %v", err)
		}
		res.Body.Close()
	}
	conn, res, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/ws?token="+token, http.Header{"Origin": []string{"https://evil.example"}})
	if conn != nil {
		conn.Close()
	}
	if err == nil || res == nil || res.StatusCode != 403 {
		t.Fatal("bad Origin accepted")
	}
	res.Body.Close()
	c := dial(t, f, token)
	until(t, c, "WELCOME")
	until(t, c, "WORLD_STATS")
	send(t, c, "MOVE", map[string]any{"x": 200, "z": 110, "rotation": 0})
	errorCode(t, c, "INVALID_MOVE")
	send(t, c, "MOVE", map[string]any{"x": 110, "z": 110})
	errorCode(t, c, "INVALID_MOVE")
	send(t, c, "CALCULATOR", map[string]any{})
	errorCode(t, c, "INVALID_TRADE")
}
func TestMultiplayerAIQuizAndRestart(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	cata, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	aiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		reply := game.Reply{Tokens: []game.Token{cata.Words["word_expensive"], cata.Words["word_jade"], cata.Words["word_teapot"]}, Emotion: "neutral", Price: 700, MianziDelta: 10, AggroDelta: 5, State: "HAGGLING", Choices: game.Choices()}
		json.NewEncoder(w).Encode(map[string]any{"raw": "", "parsed": reply})
	}))
	defer aiServer.Close()
	path := filepath.Join(t.TempDir(), "game.db")
	f := start(t, path, aiServer.URL)
	tokenA := account(t, f, "alice", "business")
	tokenB := account(t, f, "boris", "culture")
	a := dial(t, f, tokenA)
	until(t, a, "WELCOME")
	until(t, a, "WORLD_STATS")
	b := dial(t, f, tokenB)
	until(t, b, "WELCOME")
	until(t, b, "WORLD_STATS")
	until(t, a, "PLAYER_JOIN")
	until(t, b, "PLAYER_JOIN")
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	until(t, a, "DIALOGUE_PENDING")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("AI did not start")
	}
	// Neither live movement nor SQLite may be held while waiting for inference.
	send(t, b, "MOVE", map[string]any{"x": 111, "z": 110, "rotation": 1})
	until(t, a, "PLAYER_MOVE")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err = f.store.Words(ctx, 1); err != nil {
		t.Fatalf("AI held SQLite: %v", err)
	}
	unblock()
	var speechA, speechB hub.Speech
	json.Unmarshal(until(t, a, "NPC_SPEECH"), &speechA)
	json.Unmarshal(until(t, b, "NPC_SPEECH"), &speechB)
	if speechA.Fallback || speechA.Tokens[0].RU == "[???]" || speechA.Tokens[1].RU != "[???]" || speechB.Tokens[0].RU != "[???]" || speechB.Tokens[1].RU == "[???]" {
		t.Fatalf("bad subtitles: %+v %+v", speechA, speechB)
	}
	if speechA.TurnID == "" || len(speechA.Choices) != 4 || speechB.TurnID != speechA.TurnID || len(speechB.Choices) != 4 {
		t.Fatal("choice ownership broken")
	}
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": "stale"})
	errorCode(t, a, "STALE_CHOICE")
	oldTurn := speechA.TurnID
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": oldTurn})
	json.Unmarshal(until(t, a, "NPC_SPEECH"), &speechA)
	until(t, b, "NPC_SPEECH")
	if speechA.TurnID == oldTurn {
		t.Fatal("turn was not advanced")
	}
	send(t, a, "DIALOGUE", map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": oldTurn})
	errorCode(t, a, "STALE_CHOICE")
	send(t, a, "CHAT", map[string]any{"text": "hello LAN"})
	until(t, a, "CHAT")
	until(t, b, "CHAT")
	// Wrong answer cannot grant a word; a new valid quiz can.
	send(t, a, "INSPECT", map[string]any{"item_id": "teapot"})
	var quiz struct {
		ID string `json:"quiz_id"`
	}
	json.Unmarshal(until(t, a, "QUIZ"), &quiz)
	send(t, a, "INSPECT", map[string]any{"item_id": "teapot", "answer_id": 2, "quiz_id": quiz.ID})
	until(t, a, "QUIZ_RESULT")
	words, _ := f.store.Words(ctx, 1)
	for _, w := range words {
		if w == "word_teapot" {
			t.Fatal("wrong answer learned word")
		}
	}
	send(t, a, "INSPECT", map[string]any{"item_id": "teapot"})
	json.Unmarshal(until(t, a, "QUIZ"), &quiz)
	send(t, a, "INSPECT", map[string]any{"item_id": "teapot", "answer_id": 1, "quiz_id": quiz.ID})
	until(t, a, "WORD_LEARNED")
	var refreshed hub.Speech
	json.Unmarshal(until(t, a, "NPC_SPEECH"), &refreshed)
	if refreshed.Tokens[2].RU == "[???]" {
		t.Fatal("subtitles not refreshed")
	}
	send(t, a, "INSPECT", map[string]any{"item_id": "teapot", "answer_id": 1, "quiz_id": quiz.ID})
	errorCode(t, a, "STALE_QUIZ")
	// Crossing chunks must unload before loading, including transitions far away.
	send(t, a, "MOVE", map[string]any{"x": 151, "z": 110, "rotation": 2})
	loaded := map[string]bool{}
	for _, id := range []string{"4_4", "4_5", "4_6", "5_4", "5_5", "5_6", "6_4", "6_5", "6_6"} {
		loaded[id] = true
	}
	sawUnload := false
	for {
		var p hub.Packet
		a.SetReadDeadline(time.Now().Add(4 * time.Second))
		if err := a.ReadJSON(&p); err != nil {
			t.Fatal(err)
		}
		switch p.Type {
		case "CHUNK_UNLOAD":
			sawUnload = true
			var u struct {
				IDs []string `json:"chunk_ids"`
			}
			json.Unmarshal(p.Payload, &u)
			for _, id := range u.IDs {
				delete(loaded, id)
			}
		case "CHUNK_LOAD":
			if !sawUnload {
				t.Fatal("load before unload")
			}
			var ch game.Chunk
			json.Unmarshal(p.Payload, &ch)
			loaded[ch.ID] = true
			if len(loaded) > 9 {
				t.Fatal("transient chunk budget exceeded")
			}
		}
		if p.Type == "WORLD_STATS" {
			var stats struct {
				Percent float64 `json:"data_percent"`
			}
			json.Unmarshal(p.Payload, &stats)
			if stats.Percent > 10 {
				t.Fatal("data budget exceeded")
			}
			break
		}
	}
	until(t, b, "PLAYER_LEAVE")
	// This move was not followed by a periodic tick: shutdown must flush it.
	f.close()
	f2 := start(t, path, aiServer.URL)
	login := post(t, f2, "/auth/login", map[string]string{"login": "alice", "password": "password123"}, 200)
	var saved db.Player
	json.Unmarshal(login["player"], &saved)
	if saved.X != 151 || saved.Z != 110 || saved.Rotation != 2 || saved.Balance != 500 {
		t.Fatalf("restart lost player %+v", saved)
	}
	var vocabulary []string
	json.Unmarshal(login["known_words"], &vocabulary)
	found := false
	for _, w := range vocabulary {
		found = found || w == "word_teapot"
	}
	if !found {
		t.Fatal("restart lost vocabulary")
	}
	rel, err := f2.store.Relation(context.Background(), saved.ID, "lao_wang", 800, 120)
	if err != nil || rel.Mianzi != 70 || rel.Price != 700 || rel.Floor != 120 || len(rel.History) != 4 {
		t.Fatalf("restart lost relation: %+v %v", rel, err)
	}
	bob, err := f2.store.Relation(context.Background(), 2, "lao_wang", 800, 120)
	if err != nil || bob.Mianzi != 50 || bob.Price != 800 {
		t.Fatal("personal relations leaked")
	}
}
func TestUnavailableAIUsesFallback(t *testing.T) {
	f := start(t, filepath.Join(t.TempDir(), "game.db"), "http://127.0.0.1:1")
	c := dial(t, f, account(t, f, "alice", "business"))
	until(t, c, "WELCOME")
	until(t, c, "WORLD_STATS")
	send(t, c, "DIALOGUE", map[string]any{"npc_id": "lao_wang"})
	var s hub.Speech
	json.Unmarshal(until(t, c, "NPC_SPEECH"), &s)
	if !s.Fallback || len(s.Choices) != 4 || s.Price != 800 {
		t.Fatalf("missing fallback %+v", s)
	}
}

func TestPeriodicAndDisconnectPositionSave(t *testing.T) {
	f := start(t, filepath.Join(t.TempDir(), "game.db"), "http://127.0.0.1:1")
	a := dial(t, f, account(t, f, "alice", "business"))
	until(t, a, "WELCOME")
	until(t, a, "WORLD_STATS")
	b := dial(t, f, account(t, f, "boris", "culture"))
	until(t, b, "WELCOME")
	until(t, b, "WORLD_STATS")
	until(t, a, "PLAYER_JOIN")
	until(t, b, "PLAYER_JOIN")
	send(t, a, "MOVE", map[string]any{"x": 111.75, "z": 110, "rotation": 0.25})
	until(t, b, "PLAYER_MOVE")
	deadline := time.Now().Add(4 * time.Second)
	for {
		p, err := f.store.Player(context.Background(), 1)
		if err != nil {
			t.Fatal(err)
		}
		if p.X == 111.75 && p.Rotation == 0.25 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("periodic position flush missing")
		}
		time.Sleep(20 * time.Millisecond)
	}
	send(t, a, "MOVE", map[string]any{"x": 113.5, "z": 110, "rotation": 0.5})
	until(t, b, "PLAYER_MOVE")
	a.Close()
	until(t, b, "PLAYER_LEAVE")
	p, err := f.store.Player(context.Background(), 1)
	if err != nil || p.X != 113.5 || p.Rotation != 0.5 {
		t.Fatalf("disconnect did not save latest position: %+v %v", p, err)
	}
}

func TestInspectableItemArrivesInAOI(t *testing.T) {
	f := start(t, filepath.Join(t.TempDir(), "game.db"), "http://127.0.0.1:1")
	c := dial(t, f, account(t, f, "alice", "business"))
	until(t, c, "WELCOME")
	raw := until(t, c, "CHUNK_LOAD")
	var chunk game.Chunk
	if err := json.Unmarshal(raw, &chunk); err != nil {
		t.Fatal(err)
	}
	if chunk.ID != "5_5" || len(chunk.Items) != 2 || chunk.Items[0].ID != "teapot" || chunk.Items[0].X != 12 || chunk.Items[0].Z != 10 {
		t.Fatalf("inspectable item was not delivered to client: %s", raw)
	}
	if bytes.Contains(raw, []byte("answer_id")) {
		t.Fatal("world leaked quiz answer")
	}
	send(t, c, "INSPECT", map[string]any{"item_id": chunk.Items[0].ID})
	var quiz struct {
		Options []game.Option `json:"options"`
	}
	if err := json.Unmarshal(until(t, c, "QUIZ"), &quiz); err != nil || len(quiz.Options) != 4 {
		t.Fatalf("discovered item cannot be inspected: %+v %v", quiz, err)
	}
}
