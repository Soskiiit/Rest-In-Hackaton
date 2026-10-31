package hub

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
	"log"
	"time"
)

type pendingTrade struct {
	ID, NPCID, ItemID string
	Version           int64
	Expires           time.Time
}

func (h *Hub) tradeStart(c *client, raw []byte) {
	var v struct {
		NPCID  string `json:"npc_id"`
		ItemID string `json:"item_id"`
	}
	if Decode(raw, &v) != nil {
		h.fail(c, "INVALID_TRADE")
		return
	}
	product, ok := h.catalog.Products[v.ItemID]
	npc, npcOK := h.catalog.NPCs[v.NPCID]
	if !ok || !npcOK || product.NPCID != npc.ID || npc.Kind == "guard" {
		h.fail(c, "INVALID_PRODUCT")
		return
	}
	if !game.Near(c.player.X, c.player.Z, npc.X, npc.Z, interactionRadius) {
		h.fail(c, "NPC_OUT_OF_RANGE")
		return
	}
	s, err := h.getScene(npc.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	if c.pending || s.owner != nil {
		h.fail(c, "DIALOGUE_BUSY")
		return
	}
	if s.data.Version == 0 || s.data.State == "IDLE" || s.data.State == "CALLING" {
		h.fail(c, "DIALOGUE_REQUIRED")
		return
	}
	if s.data.State == "AGGRO" || s.data.Aggro > 75 {
		h.fail(c, "NPC_AGGRO")
		return
	}
	items, err := h.store.Inventory(h.ctx, c.player.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	for _, item := range items {
		if item.ID == v.ItemID {
			h.fail(c, "ITEM_ALREADY_OWNED")
			return
		}
	}
	c.trade = &pendingTrade{ID: rand.Text(), NPCID: npc.ID, ItemID: product.ID, Version: s.data.Version, Expires: time.Now().Add(30 * time.Second)}
	word := game.Filter([]game.Token{h.catalog.Words[product.WordID]}, c.known)[0]
	h.emit(c, "TRADE_OPEN", map[string]any{"trade_id": c.trade.ID, "npc_id": npc.ID, "item_id": product.ID, "price": s.data.Price, "balance": c.player.Balance, "expires_at": c.trade.Expires.UTC().Format(time.RFC3339Nano), "scene_version": s.data.Version, "word": word})
}
func (h *Hub) calculator(c *client, raw []byte) {
	var v struct {
		NPCID   string `json:"npc_id"`
		ItemID  string `json:"item_id"`
		TradeID string `json:"trade_id"`
		Amount  *int   `json:"amount"`
	}
	if Decode(raw, &v) != nil || v.Amount == nil || *v.Amount < 1 || *v.Amount > 100000 || v.TradeID == "" {
		h.fail(c, "INVALID_TRADE")
		return
	}
	receipt, err := h.store.Receipt(h.ctx, c.player.ID, v.TradeID)
	if err == nil {
		if receipt.NPCID != v.NPCID || receipt.ItemID != v.ItemID || receipt.Amount != *v.Amount {
			h.fail(c, "INVALID_TRADE")
			return
		}
		h.purchaseResult(c, receipt, true)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		h.fail(c, "DB_ERROR")
		return
	}
	t := c.trade
	if t == nil || t.ID != v.TradeID || t.NPCID != v.NPCID || t.ItemID != v.ItemID {
		h.fail(c, "STALE_TRADE")
		return
	}
	if !time.Now().Before(t.Expires) {
		c.trade = nil
		h.fail(c, "TRADE_EXPIRED")
		return
	}
	npc, ok := h.catalog.NPCs[t.NPCID]
	if !ok || !game.Near(c.player.X, c.player.Z, npc.X, npc.Z, interactionRadius) {
		c.trade = nil
		h.fail(c, "NPC_OUT_OF_RANGE")
		return
	}
	s, err := h.getScene(npc.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	if s.owner != nil {
		h.fail(c, "DIALOGUE_BUSY")
		return
	}
	if s.data.Version != t.Version {
		c.trade = nil
		h.fail(c, "STALE_TRADE")
		return
	}
	if s.data.State == "AGGRO" || s.data.Aggro > 75 {
		c.trade = nil
		h.fail(c, "NPC_AGGRO")
		return
	}
	if *v.Amount < s.data.Floor {
		if err = h.rejectPrice(c, s, *v.Amount); err != nil {
			log.Printf("reject price: %v", err)
			h.fail(c, "DB_ERROR")
			return
		}
		c.trade = nil
		h.emit(c, "TRADE_RESULT", map[string]any{"status": "rejected", "trade_id": t.ID, "reason": "PRICE_TOO_LOW"})
		return
	}
	receipt, replayed, err := h.store.Buy(h.ctx, c.player.ID, t.ID, t.NPCID, t.ItemID, *v.Amount, t.Version)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrFunds), errors.Is(err, db.ErrOwned), errors.Is(err, db.ErrStale), errors.Is(err, db.ErrTrade):
			h.fail(c, err.Error())
		default:
			log.Printf("purchase: %v", err)
			h.fail(c, "DB_ERROR")
		}
		return
	}
	c.trade = nil
	h.invalidateSceneViews(npc.ID)
	delete(h.scenes, npc.ID)
	h.purchaseResult(c, receipt, replayed)
	if current, err := h.getScene(npc.ID); err == nil {
		for _, observer := range h.nearby(npc.X, npc.Z, speechRadius) {
			h.emit(observer, "NPC_STATE", h.state(current))
			h.emit(observer, "PURCHASE", map[string]any{"player_id": c.player.ID, "npc_id": npc.ID, "item_id": receipt.ItemID, "amount": receipt.Amount})
		}
	}
}
func (h *Hub) purchaseResult(c *client, r db.Receipt, replayed bool) {
	p, err := h.store.Player(h.ctx, c.player.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	items, err := h.store.Inventory(h.ctx, c.player.ID)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	c.player.Balance = p.Balance
	delta := -r.Amount
	if replayed {
		delta = 0
	}
	h.emit(c, "TRADE_RESULT", map[string]any{"status": "purchased", "receipt": r, "replayed": replayed})
	h.emit(c, "BALANCE", map[string]any{"balance": p.Balance, "delta": delta})
	h.emit(c, "INVENTORY", map[string]any{"items": items})
}
func (h *Hub) rejectPrice(c *client, s *liveScene, amount int) error {
	npc := h.catalog.NPCs[s.data.NPCID]
	personal, err := h.store.Relation(h.ctx, c.player.ID, npc.ID, npc.Price, npc.Floor)
	if err != nil {
		return err
	}
	r := s.data.Relation
	r.PlayerID = c.player.ID
	r.History = personal.History
	choice := game.Choice{Type: "provoke"}
	reply := game.Fallback(r, &choice, h.catalog)
	text := fmt.Sprintf("Предложение цены %d юаней", amount)
	personal = game.AppendHistory(game.Apply(r, reply), text, reply)
	next := s.data
	next.Relation = game.AppendHistory(game.Apply(next.Relation, reply), c.player.Login+": "+text, reply)
	stored := storedReply{Reply: reply, Actor: c.player.ID, Fallback: true}
	raw, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	version, err := h.store.CommitScene(h.ctx, next, personal, raw)
	if err != nil {
		return err
	}
	h.invalidateSceneViews(npc.ID)
	next.Version = version
	next.Reply = raw
	s.data = next
	s.stored = &stored
	h.broadcastScene(s)
	return nil
}
