package hub

import (
	"encoding/json"
	"fmt"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"math"
	"sort"
)

const interactionRadius = 5.0
const speechRadius = 15.0

type storedReply struct {
	Reply    game.Reply `json:"reply"`
	Actor    int64      `json:"actor"`
	Fallback bool       `json:"fallback"`
}
type liveScene struct {
	data   db.Scene
	stored *storedReply
	owner  *client
}

func turnID(s *liveScene) string {
	if s.stored == nil {
		return ""
	}
	return fmt.Sprintf("%s:%d", s.data.NPCID, s.data.Version)
}
func (h *Hub) getScene(id string) (*liveScene, error) {
	if h.scenes == nil {
		h.scenes = map[string]*liveScene{}
	}
	if s := h.scenes[id]; s != nil {
		return s, nil
	}
	npc := h.catalog.NPCs[id]
	data, err := h.store.Scene(h.ctx, id, npc.Price, npc.Floor)
	if err != nil {
		return nil, err
	}
	s := &liveScene{data: data}
	if string(data.Reply) != "null" {
		var stored storedReply
		if err = json.Unmarshal(data.Reply, &stored); err != nil {
			return nil, err
		}
		s.stored = &stored
	}
	h.scenes[id] = s
	return s, nil
}
func (h *Hub) releaseScene(c *client) {
	for _, s := range h.scenes {
		if s.owner == c {
			s.owner = nil
			h.invalidateSceneViews(s.data.NPCID)
			h.dialogueDone(s, "cancelled")
		}
	}
	c.pending = false
}
func (h *Hub) index(c *client, old string) {
	if h.cells == nil {
		h.cells = map[string]map[int64]*client{}
	}
	if old != "" {
		delete(h.cells[old], c.player.ID)
		if len(h.cells[old]) == 0 {
			delete(h.cells, old)
		}
	}
	id := game.ChunkID(c.player.X, c.player.Z)
	if h.cells[id] == nil {
		h.cells[id] = map[int64]*client{}
	}
	h.cells[id][c.player.ID] = c
}
func (h *Hub) unindex(c *client) {
	id := game.ChunkID(c.player.X, c.player.Z)
	delete(h.cells[id], c.player.ID)
	if len(h.cells[id]) == 0 {
		delete(h.cells, id)
	}
}
func (h *Hub) nearby(x, z, r float64) []*client {
	out := []*client{}
	if !game.Finite(x) || !game.Finite(z) {
		return out // an NPC removed in the level editor has no position and no listeners
	}
	if h.cells == nil {
		for _, c := range h.clients {
			if game.Near(c.player.X, c.player.Z, x, z, r) {
				out = append(out, c)
			}
		}
		return out
	}
	for cx := int(math.Floor((x - r) / 20)); cx <= int(math.Floor((x+r)/20)); cx++ {
		for cz := int(math.Floor((z - r) / 20)); cz <= int(math.Floor((z+r)/20)); cz++ {
			for _, c := range h.cells[fmt.Sprintf("%d_%d", cx, cz)] {
				if game.Near(c.player.X, c.player.Z, x, z, r) {
					out = append(out, c)
				}
			}
		}
	}
	return out
}
func (h *Hub) offers(npc string) []string {
	out := []string{}
	for id, p := range h.catalog.Products {
		if p.NPCID == npc {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}
func (h *Hub) state(s *liveScene, c *client) map[string]any {
	state := map[string]any{"npc_id": s.data.NPCID, "state": s.data.State, "mianzi": s.data.Mianzi, "aggro": s.data.Aggro, "price": s.data.Price, "scene_version": s.data.Version, "turn_id": turnID(s), "offers": h.offers(s.data.NPCID), "busy": s.owner != nil}
	npc := h.catalog.NPCs[s.data.NPCID]
	relation, err := h.store.Relation(h.ctx, c.player.ID, npc.ID, npc.Price, npc.Floor)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return state
	}
	state["personal_aggro"] = relation.Aggro
	state["stall_closed"] = npc.Kind == "merchant" && relation.Aggro >= 100
	return state
}
func (h *Hub) sendScene(c *client, s *liveScene) {
	state := h.state(s, c)
	h.emit(c, "NPC_STATE", state)
	if s.stored == nil {
		return
	}
	p := s.stored.Reply
	speech := Speech{
		NPCID:        s.data.NPCID,
		PlayerID:     s.stored.Actor,
		Tokens:       p.Tokens,
		Choices:      []game.Choice{},
		Emotion:      p.Emotion,
		Mianzi:       s.data.Mianzi,
		Aggro:        s.data.Aggro,
		Price:        s.data.Price,
		State:        s.data.State,
		Fallback:     s.stored.Fallback,
		Offers:       h.offers(s.data.NPCID),
		SceneVersion: s.data.Version,
		AudioBase64:  p.AudioBase64,
	}
	if aggro, ok := state["personal_aggro"].(int); ok {
		speech.Aggro = aggro
	}
	speech.StallClosed, _ = state["stall_closed"].(bool)
	npc := h.catalog.NPCs[s.data.NPCID]
	if game.Near(c.player.X, c.player.Z, npc.X, npc.Z, interactionRadius) {
		speech.TurnID = turnID(s)
		speech.Choices = append([]game.Choice{}, p.Choices...)
		c.activeNPC = npc.ID
		c.turn = speech.TurnID
		c.choices = speech.Choices
	}
	c.speech = &speech
	h.sendSpeech(c, speech)
}
func (h *Hub) broadcastScene(s *liveScene) {
	npc := h.catalog.NPCs[s.data.NPCID]
	for _, c := range h.nearby(npc.X, npc.Z, speechRadius) {
		h.sendScene(c, s)
	}
}
func (h *Hub) syncScenes(c *client) {
	if c.sceneRanges == nil {
		c.sceneRanges = map[string]int{}
	}
	for id, npc := range h.catalog.NPCs {
		radius := 0
		if game.Near(c.player.X, c.player.Z, npc.X, npc.Z, speechRadius) {
			radius = 1
		}
		if game.Near(c.player.X, c.player.Z, npc.X, npc.Z, interactionRadius) {
			radius = 2
		}
		if radius == c.sceneRanges[id] {
			continue
		}
		c.sceneRanges[id] = radius
		if radius < 2 && c.trade != nil && c.trade.NPCID == id {
			c.trade = nil
		}
		if radius == 0 {
			h.emit(c, "NPC_LEAVE", map[string]string{"npc_id": id})
			if c.speech != nil && c.speech.NPCID == id {
				c.speech = nil
			}
			continue
		}
		scene, err := h.getScene(id)
		if err != nil {
			h.fail(c, "DB_ERROR")
			continue
		}
		h.sendScene(c, scene)
	}
}

func (h *Hub) invalidateSceneViews(npc string) {
	for _, c := range h.clients {
		if c.speech != nil && c.speech.NPCID == npc {
			c.speech = nil
		}
		if c.activeNPC == npc {
			c.turn = ""
			c.choices = nil
			c.activeNPC = ""
		}
	}
}
func (h *Hub) dialogueDone(s *liveScene, status string) {
	if status != "completed" {
		h.invalidateSceneViews(s.data.NPCID)
	}
	npc := h.catalog.NPCs[s.data.NPCID]
	for _, observer := range h.nearby(npc.X, npc.Z, speechRadius) {
		h.emit(observer, "NPC_STATE", h.state(s, observer))
		h.emit(observer, "DIALOGUE_DONE", map[string]any{"npc_id": npc.ID, "status": status, "scene_version": s.data.Version})
	}
}
