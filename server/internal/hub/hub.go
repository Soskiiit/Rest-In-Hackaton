// Package hub owns live game state in one event loop; AI workers never mutate it.
package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"io"
	"log"
	"math"
	"sync"
	"time"
)

type Packet struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func Decode(raw []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("expected one JSON value")
	}
	return nil
}

type client struct {
	trade       *pendingTrade
	sceneRanges map[string]int
	conn        *websocket.Conn
	send        chan []byte
	done        chan struct{}
	cancel      context.CancelFunc
	ctx         context.Context
	player      db.Player
	expires     time.Time
	loaded      map[string]bool
	visible     map[int64]bool
	known       map[string]bool
	dirty       bool
	pending     bool
	turn        string
	activeNPC   string
	choices     []game.Choice
	speech      *Speech
	quiz        string
	quizItem    string
	lastChat    time.Time
	window      time.Time
	count       int
}
type Speech struct {
	NPCID        string        `json:"npc_id"`
	PlayerID     int64         `json:"player_id"`
	Tokens       []game.Token  `json:"tokens"`
	Choices      []game.Choice `json:"choices"`
	TurnID       string        `json:"turn_id"`
	Emotion      string        `json:"emotion"`
	Mianzi       int           `json:"mianzi"`
	Aggro        int           `json:"aggro"`
	Price        int           `json:"price"`
	State        string        `json:"state"`
	Fallback     bool          `json:"fallback"`
	Offers       []string      `json:"offers"`
	SceneVersion int64         `json:"scene_version"`
	AudioBase64  string        `json:"audio_base64,omitempty"`
}
type join struct {
	accepted chan struct{}
	conn     *websocket.Conn
	id       int64
	expires  time.Time
}
type leave struct{ c *client }
type incoming struct {
	c *client
	p Packet
}
type aiDone struct {
	scene    db.Scene
	c        *client
	relation db.Relation
	reply    game.Reply
	text     string
	fallback bool
}
type worldRequest struct {
	updates  map[string]db.WorldChunk
	response chan worldResponse
}
type worldResponse struct {
	chunks map[string]db.WorldChunk
	err    error
}
type aiPartial struct {
	scene    db.Scene
	c        *client
	relation db.Relation
	partial  game.PartialReply
}
type Hub struct {
	scenes  map[string]*liveScene
	cells   map[string]map[int64]*client
	store   *db.Store
	world   *game.World
	catalog *game.Catalog
	ai      *game.AI
	events  chan any
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	clients map[int64]*client
}

func New(s *db.Store, w *game.World, c *game.Catalog, ai *game.AI) *Hub {
	ctx, cancel := context.WithCancel(context.Background())
	h := &Hub{store: s, world: w, catalog: w.PlaceCatalog(c), ai: ai, events: make(chan any, 512), stop: make(chan struct{}), done: make(chan struct{}), ctx: ctx, cancel: cancel, clients: map[int64]*client{}}
	go h.run()
	return h
}

// World serializes snapshots and edits with all game events.
func (h *Hub) World(ctx context.Context, updates map[string]db.WorldChunk) (map[string]db.WorldChunk, error) {
	reply := make(chan worldResponse, 1)
	select {
	case h.events <- worldRequest{updates: updates, response: reply}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-h.done:
		return nil, errors.New("hub closed")
	}
	select {
	case result := <-reply:
		return result.chunks, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-h.done:
		return nil, errors.New("hub closed")
	}
}
func (h *Hub) worldRequest(e worldRequest) {
	if e.updates != nil {
		if len(e.updates) == 0 || len(e.updates) > len(h.world.Chunks) {
			e.response <- worldResponse{err: errors.New("invalid world edit")}
			return
		}
		raw := make(map[string]json.RawMessage, len(e.updates))
		for id, u := range e.updates {
			if u.Revision < 1 || h.world.Revisions[id] != u.Revision {
				e.response <- worldResponse{err: db.ErrWorldConflict}
				return
			}
			raw[id] = u.Data
		}
		candidate, err := h.world.Updated(raw, h.catalog)
		if err != nil {
			e.response <- worldResponse{err: err}
			return
		}
		if err = h.store.SaveWorld(h.ctx, e.updates); err != nil {
			e.response <- worldResponse{err: err}
			return
		}
		ids := make([]string, 0, len(e.updates))
		for id := range e.updates {
			candidate.Revisions[id]++
			ids = append(ids, id)
		}
		h.world = candidate
		h.applyWorldEdit(ids)
	}
	result := make(map[string]db.WorldChunk, len(h.world.Chunks))
	for id, chunk := range h.world.Chunks {
		raw, _ := json.Marshal(chunk)
		result[id] = db.WorldChunk{Data: raw, Revision: h.world.Revisions[id]}
	}
	e.response <- worldResponse{chunks: result}
}

func (h *Hub) Attach(conn *websocket.Conn, id int64, expires time.Time) {
	accepted := make(chan struct{})
	select {
	case h.events <- join{accepted: accepted, conn: conn, id: id, expires: expires}:
		select {
		case <-accepted:
		case <-h.done:
			conn.Close()
		}
	case <-h.done:
		conn.Close()
	}
}
func (h *Hub) Close() { h.once.Do(func() { close(h.stop) }); <-h.done; h.wg.Wait() }
func (h *Hub) run() {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	defer close(h.done)
	for {
		select {
		case <-h.stop:
			h.save()
			for _, c := range h.clients {
				h.closeClient(c)
			}
			h.cancel()
			return
		case <-tick.C:
			h.save()
			for _, c := range h.clients {
				if !time.Now().Before(c.expires) {
					h.remove(c)
				}
			}
		case event := <-h.events:
			switch e := event.(type) {
			case worldRequest:
				h.worldRequest(e)
			case join:
				h.add(e)
			case leave:
				if h.clients[e.c.player.ID] == e.c {
					h.remove(e.c)
				}
			case incoming:
				if h.clients[e.c.player.ID] == e.c {
					h.handle(e.c, e.p)
				}
			case aiDone:
				if h.clients[e.c.player.ID] == e.c {
					h.finishDialogue(e)
				}
			case aiPartial:
				if h.clients[e.c.player.ID] == e.c {
					h.partialDialogue(e)
				}
			}
		}
	}
}
func (h *Hub) emit(c *client, kind string, payload any) {
	b, err := json.Marshal(map[string]any{"type": kind, "payload": payload})
	if err != nil {
		log.Printf("encode %s: %v", kind, err)
		return
	}
	select {
	case c.send <- b:
	default:
		c.conn.Close()
	}
}
func (h *Hub) fail(c *client, code string) { h.emit(c, "ERROR", map[string]string{"code": code}) }
func (h *Hub) add(e join) {
	defer close(e.accepted)
	if _, exists := h.clients[e.id]; exists {
		e.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "account already connected"), time.Now().Add(time.Second))
		e.conn.Close()
		return
	}
	p, err := h.store.Player(h.ctx, e.id)
	if err != nil {
		e.conn.Close()
		return
	}
	words, err := h.store.Words(h.ctx, p.ID)
	if err != nil {
		e.conn.Close()
		return
	}
	inventory, err := h.store.Inventory(h.ctx, p.ID)
	if err != nil {
		e.conn.Close()
		return
	}
	ctx, cancel := context.WithCancel(h.ctx)
	c := &client{conn: e.conn, send: make(chan []byte, 256), done: make(chan struct{}), ctx: ctx, cancel: cancel, player: p, expires: e.expires, loaded: map[string]bool{}, visible: map[int64]bool{}, known: map[string]bool{}}
	for _, w := range words {
		c.known[w] = true
	}
	// Universal conversational base words for all player tourists
	if !c.known["word_hello"] {
		c.known["word_hello"] = true
		words = append(words, "word_hello")
	}
	if !c.known["word_this"] {
		c.known["word_this"] = true
		words = append(words, "word_this")
	}
	h.clients[p.ID] = c
	h.index(c, "")
	h.wg.Add(2)
	go h.read(c)
	go h.write(c)
	h.emit(c, "WELCOME", map[string]any{"player": p, "known_words": words, "inventory": inventory, "world": map[string]any{"total_chunks": 100, "total_bytes": h.world.TotalBytes, "chunk_size": 20, "max_percent": 10}})
	h.stream(c)
	h.visibility()
	h.syncScenes(c)
}
func (h *Hub) closeClient(c *client) { h.releaseScene(c); c.cancel(); close(c.done); c.conn.Close() }
func (h *Hub) remove(c *client) {
	if err := h.store.SavePositions(h.ctx, []db.Player{c.player}); err != nil {
		log.Printf("save disconnect %d: %v", c.player.ID, err)
	}
	h.unindex(c)
	delete(h.clients, c.player.ID)
	h.closeClient(c)
	h.visibility()
}
func (h *Hub) save() {
	ps := []db.Player{}
	for _, c := range h.clients {
		if c.dirty {
			ps = append(ps, c.player)
		}
	}
	if err := h.store.SavePositions(h.ctx, ps); err != nil {
		log.Printf("save positions: %v", err)
		return
	}
	for _, c := range h.clients {
		c.dirty = false
	}
}
func (h *Hub) read(c *client) {
	defer h.wg.Done()
	defer func() {
		select {
		case h.events <- leave{c}:
		case <-h.done:
		}
	}()
	c.conn.SetReadLimit(8192)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error { return c.conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		p := Packet{}
		if kind != websocket.TextMessage || Decode(data, &p) != nil || p.Type == "" || len(p.Payload) == 0 {
			p = Packet{Type: "INVALID"}
		}
		select {
		case h.events <- incoming{c, p}:
		case <-c.done:
			return
		case <-h.done:
			return
		}
	}
}
func (h *Hub) write(c *client) {
	defer h.wg.Done()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-c.done:
			return
		case data := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				c.conn.Close()
				return
			}
		case <-ping.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				c.conn.Close()
				return
			}
		}
	}
}
func (h *Hub) stream(c *client) {
	ids := h.world.AOI(c.player.X, c.player.Z)
	next := map[string]bool{}
	bytes := 0
	for _, id := range ids {
		next[id] = true
		bytes += h.world.Sizes[id]
	}
	unload := []string{}
	for id := range c.loaded {
		if !next[id] {
			unload = append(unload, id)
		}
	}
	if len(unload) > 0 {
		h.emit(c, "CHUNK_UNLOAD", map[string]any{"chunk_ids": unload})
	}
	for _, id := range ids {
		if !c.loaded[id] {
			h.emit(c, "CHUNK_LOAD", struct {
				game.Chunk
				Revision int64 `json:"revision"`
			}{h.world.Chunks[id], h.world.Revisions[id]})
		}
	}
	c.loaded = next
	h.emit(c, "WORLD_STATS", map[string]any{"loaded_chunks": len(ids), "total_chunks": 100, "loaded_bytes": bytes, "total_bytes": h.world.TotalBytes, "data_percent": float64(bytes) * 100 / float64(h.world.TotalBytes), "chunk_percent": len(ids)})
}
func (h *Hub) visibility() {
	for _, c := range h.clients {
		next := map[int64]bool{}
		for id, other := range h.clients {
			if id == c.player.ID || !c.loaded[game.ChunkID(other.player.X, other.player.Z)] {
				continue
			}
			next[id] = true
			if !c.visible[id] {
				h.emit(c, "PLAYER_JOIN", publicPlayer(other.player))
			}
		}
		for id := range c.visible {
			if !next[id] {
				h.emit(c, "PLAYER_LEAVE", map[string]any{"player_id": id})
			}
		}
		c.visible = next
	}
}

// applyWorldEdit moves NPCs and items to their new places and re-sends the changed chunks
// to everyone who has them loaded, so nobody has to reconnect.
func (h *Hub) applyWorldEdit(ids []string) {
	h.catalog = h.world.PlaceCatalog(h.catalog)
	for _, c := range h.clients {
		stale := []string{}
		for _, id := range ids {
			if c.loaded[id] {
				stale = append(stale, id)
				delete(c.loaded, id)
			}
		}
		if len(stale) > 0 {
			h.emit(c, "CHUNK_UNLOAD", map[string]any{"chunk_ids": stale})
		}
		h.stream(c)
		h.syncScenes(c)
	}
}

// publicPlayer is what other players may see: the wallet stays private (BALANCE/WELCOME go to the owner only).
func publicPlayer(p db.Player) map[string]any {
	return map[string]any{"id": p.ID, "login": p.Login, "profile": p.Profile, "x": p.X, "z": p.Z, "rotation": p.Rotation}
}
func (h *Hub) handle(c *client, p Packet) {
	if !time.Now().Before(c.expires) {
		h.remove(c)
		return
	}
	now := time.Now()
	if now.Sub(c.window) >= time.Second {
		c.window = now
		c.count = 0
	}
	c.count++
	if c.count > 120 {
		c.conn.Close()
		return
	}
	if c.count > 60 {
		if c.count == 61 {
			h.fail(c, "RATE_LIMIT")
		}
		return
	}
	switch p.Type {
	case "MOVE":
		var v struct {
			X        *float64 `json:"x"`
			Z        *float64 `json:"z"`
			Rotation *float64 `json:"rotation"`
		}
		if Decode(p.Payload, &v) != nil || v.X == nil || v.Z == nil || v.Rotation == nil || !game.Position(*v.X, *v.Z) || !game.Finite(*v.Rotation) {
			h.fail(c, "INVALID_MOVE")
			return
		}
		old := game.ChunkID(c.player.X, c.player.Z)
		c.player.X = *v.X
		c.player.Z = *v.Z
		c.player.Rotation = math.Mod(*v.Rotation, 2*math.Pi)
		c.dirty = true
		if old != game.ChunkID(c.player.X, c.player.Z) {
			h.index(c, old)
			h.stream(c)
			h.visibility()
		}
		h.syncScenes(c)
		for _, other := range h.clients {
			if other.visible[c.player.ID] {
				h.emit(other, "PLAYER_MOVE", map[string]any{"player_id": c.player.ID, "x": c.player.X, "z": c.player.Z, "rotation": c.player.Rotation})
			}
		}
	case "ANIMATION":
		var v struct {
			Action string `json:"action"`
		}
		if Decode(p.Payload, &v) != nil || len(v.Action) == 0 || len(v.Action) > 32 {
			h.fail(c, "INVALID_ANIMATION")
			return
		}
		for _, other := range h.clients {
			if other != c && other.visible[c.player.ID] {
				h.emit(other, "PLAYER_ANIMATION", map[string]any{"player_id": c.player.ID, "action": v.Action})
			}
		}
	case "CHAT":
		var v struct {
			Text string `json:"text"`
		}
		if Decode(p.Payload, &v) != nil || len(v.Text) == 0 || len([]rune(v.Text)) > 500 {
			h.fail(c, "INVALID_CHAT")
			return
		}
		if now.Sub(c.lastChat) < time.Second {
			h.fail(c, "CHAT_RATE_LIMIT")
			return
		}
		c.lastChat = now
		for _, other := range h.clients {
			if other == c || other.visible[c.player.ID] {
				h.emit(other, "CHAT", map[string]any{"player_id": c.player.ID, "login": c.player.Login, "text": v.Text})
			}
		}
	case "DIALOGUE":
		h.dialogue(c, p.Payload)
	case "TRADE_START":
		h.tradeStart(c, p.Payload)
	case "CALCULATOR":
		h.calculator(c, p.Payload)
	case "INSPECT":
		h.inspect(c, p.Payload)
	case "WORLD_EDIT":
		if h.world.Revisions != nil {
			h.fail(c, "INVALID_WORLD_EDIT")
			return
		}
		// The level editor saved these chunk files; tell everyone else to reload them.
		var v struct {
			ChunkIDs []string `json:"chunk_ids"`
		}
		if Decode(p.Payload, &v) != nil || len(v.ChunkIDs) == 0 || len(v.ChunkIDs) > len(h.world.Chunks) {
			h.fail(c, "INVALID_WORLD_EDIT")
			return
		}
		for _, id := range v.ChunkIDs {
			if _, ok := h.world.Chunks[id]; !ok {
				h.fail(c, "INVALID_WORLD_EDIT")
				return
			}
		}
		if err := h.world.Reload(v.ChunkIDs, h.catalog); err != nil {
			log.Printf("WORLD_EDIT from %s rejected: %v", c.player.Login, err)
			h.fail(c, "INVALID_WORLD_EDIT")
			return
		}
		h.applyWorldEdit(v.ChunkIDs)
		for _, other := range h.clients {
			if other != c {
				h.emit(other, "WORLD_EDIT", map[string]any{"chunk_ids": v.ChunkIDs, "player_id": c.player.ID, "login": c.player.Login})
			}
		}
	default:
		h.fail(c, "UNKNOWN_PACKET")
	}
}
