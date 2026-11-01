package hub

import (
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
)

// An NPC's mood is shared by everyone (the co-op mechanic), but an admin can set a personal offset per player:
// what the NPC shows and how it behaves towards that player is shared mood + offset, clamped to 0..100.

func (h *Hub) effective(c *client, npc string, mianzi, aggro int) (int, int) {
	o := c.offsets[npc]
	return game.Clamp(mianzi+o.Mianzi, 0, 100), game.Clamp(aggro+o.Aggro, 0, 100)
}

// stateFor is NPC_STATE as seen by one player.
func (h *Hub) stateFor(c *client, s *liveScene) map[string]any {
	state := h.state(s)
	state["mianzi"], state["aggro"] = h.effective(c, s.data.NPCID, s.data.Mianzi, s.data.Aggro)
	return state
}

func (h *Hub) aggroFor(c *client, s *liveScene) int {
	_, aggro := h.effective(c, s.data.NPCID, s.data.Mianzi, s.data.Aggro)
	return aggro
}

type adminAttitude struct {
	PlayerID int64  `json:"player_id"`
	Login    string `json:"login"`
	Online   bool   `json:"online"`
	Mianzi   int    `json:"mianzi"`
	Aggro    int    `json:"aggro"`
	db.Offset
}

func (h *Hub) adminRelations(c *client, raw []byte) {
	if !c.player.IsAdmin {
		h.fail(c, "ADMIN_ONLY")
		return
	}
	var v struct {
		NPCID string `json:"npc_id"`
	}
	if Decode(raw, &v) != nil {
		h.fail(c, "INVALID_ADMIN_RELATION")
		return
	}
	if _, ok := h.catalog.NPCs[v.NPCID]; !ok {
		h.fail(c, "INVALID_ADMIN_RELATION")
		return
	}
	h.sendAdminRelations(c, v.NPCID)
}

func (h *Hub) sendAdminRelations(c *client, npc string) {
	s, err := h.getScene(npc)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	rows, err := h.store.NPCAttitudes(h.ctx, npc)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	players := make([]adminAttitude, 0, len(rows))
	for _, r := range rows {
		_, online := h.clients[r.PlayerID]
		players = append(players, adminAttitude{
			PlayerID: r.PlayerID, Login: r.Login, Online: online, Offset: r.Offset,
			Mianzi: game.Clamp(s.data.Mianzi+r.Mianzi, 0, 100),
			Aggro:  game.Clamp(s.data.Aggro+r.Aggro, 0, 100),
		})
	}
	h.emit(c, "ADMIN_NPC_RELATIONS", map[string]any{
		"npc_id":  npc,
		"shared":  map[string]any{"mianzi": s.data.Mianzi, "aggro": s.data.Aggro, "state": s.data.State},
		"players": players,
	})
}

func (h *Hub) adminSetRelation(c *client, raw []byte) {
	if !c.player.IsAdmin {
		h.fail(c, "ADMIN_ONLY")
		return
	}
	var v struct {
		NPCID    string `json:"npc_id"`
		PlayerID int64  `json:"player_id"`
		Mianzi   *int   `json:"mianzi"`
		Aggro    *int   `json:"aggro"`
	}
	if Decode(raw, &v) != nil || v.Mianzi == nil || v.Aggro == nil || *v.Mianzi < 0 || *v.Mianzi > 100 || *v.Aggro < 0 || *v.Aggro > 100 {
		h.fail(c, "INVALID_ADMIN_RELATION")
		return
	}
	npc, ok := h.catalog.NPCs[v.NPCID]
	if !ok {
		h.fail(c, "INVALID_ADMIN_RELATION")
		return
	}
	if _, err := h.store.Player(h.ctx, v.PlayerID); err != nil {
		h.fail(c, "INVALID_ADMIN_RELATION")
		return
	}
	s, err := h.getScene(npc.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	// The admin sets the mood the player should see now; store it as an offset from the shared mood.
	o := db.Offset{Mianzi: game.Clamp(*v.Mianzi-s.data.Mianzi, -100, 100), Aggro: game.Clamp(*v.Aggro-s.data.Aggro, -100, 100)}
	if err = h.store.SetOffset(h.ctx, v.PlayerID, npc.ID, o, npc.Price, npc.Floor); err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	if target, online := h.clients[v.PlayerID]; online {
		if target.offsets == nil {
			target.offsets = map[string]db.Offset{}
		}
		if o == (db.Offset{}) {
			delete(target.offsets, npc.ID)
		} else {
			target.offsets[npc.ID] = o
		}
		if target.sceneRanges[npc.ID] > 0 {
			h.emit(target, "NPC_STATE", h.stateFor(target, s))
		}
	}
	h.sendAdminRelations(c, npc.ID)
}
