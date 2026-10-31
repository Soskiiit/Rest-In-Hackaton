package hub

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"hackaton/server/internal/game"
	"log"
	"time"
)

func (h *Hub) dialogue(c *client, raw []byte) {
	var v struct {
		NPCID    string `json:"npc_id"`
		ChoiceID *int   `json:"choice_id"`
		TurnID   string `json:"turn_id"`
	}
	if Decode(raw, &v) != nil {
		h.fail(c, "INVALID_DIALOGUE")
		return
	}
	npc, ok := h.catalog.NPCs[v.NPCID]
	if !ok || !game.Near(c.player.X, c.player.Z, npc.X, npc.Z, 5) {
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
	text := "Привет!"
	var choice *game.Choice
	if v.ChoiceID != nil {
		if s.stored == nil || v.TurnID == "" || v.TurnID != turnID(s) {
			h.fail(c, "STALE_CHOICE")
			return
		}
		for _, o := range s.stored.Reply.Choices {
			if o.ID == *v.ChoiceID {
				copy := o
				choice = &copy
				break
			}
		}
		if choice == nil {
			h.fail(c, "INVALID_CHOICE")
			return
		}
		text = choice.ZH + " — " + choice.RU
	} else if v.TurnID != "" {
		h.fail(c, "INVALID_DIALOGUE")
		return
	}
	if v.ChoiceID == nil && s.stored != nil {
		h.sendScene(c, s)
		return
	}
	relation, err := h.store.Relation(h.ctx, c.player.ID, npc.ID, npc.Price, npc.Floor)
	if err != nil {
		log.Printf("load relation: %v", err)
		h.fail(c, "DB_ERROR")
		return
	}
	history := relation.History
	relation = s.data.Relation
	relation.PlayerID = c.player.ID
	relation.History = history
	c.pending = true
	s.owner = c
	scene := s.data
	for _, observer := range h.nearby(npc.X, npc.Z, speechRadius) {
		h.emit(observer, "DIALOGUE_PENDING", map[string]any{"npc_id": npc.ID, "player_id": c.player.ID})
		h.emit(observer, "NPC_STATE", h.state(s))
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
		defer cancel()
		reply, err := h.ai.RequestScene(ctx, relation, text, scene.History)
		fallback := err != nil
		if fallback {
			log.Printf("AI fallback npc=%s: %v", npc.ID, err)
			reply = game.Fallback(relation, choice, h.catalog)
		}
		reply = game.Enforce(reply, relation, choice, npc)
		if c.ctx.Err() != nil {
			return
		}
		result := aiDone{c: c, scene: scene, relation: relation, reply: reply, text: text, fallback: fallback}
		select {
		case h.events <- result:
		case <-c.done:
		case <-h.done:
		}
	}()
}
func (h *Hub) finishDialogue(e aiDone) {
	c := e.c
	c.pending = false
	s := h.scenes[e.scene.NPCID]
	if s == nil || s.owner != c {
		return
	}
	s.owner = nil
	status := "cancelled"
	defer func() { h.dialogueDone(s, status) }()
	npc := h.catalog.NPCs[e.relation.NPCID]
	if !game.Near(c.player.X, c.player.Z, npc.X, npc.Z, 5) {
		h.fail(c, "NPC_OUT_OF_RANGE")
		return
	}
	if !time.Now().Before(c.expires) {
		h.remove(c)
		return
	}
	personal := game.AppendHistory(game.Apply(e.relation, e.reply), e.text, e.reply)
	shared := e.scene
	shared.Relation = game.AppendHistory(game.Apply(shared.Relation, e.reply), c.player.Login+": "+e.text, e.reply)
	stored := storedReply{Reply: e.reply, Actor: c.player.ID, Fallback: e.fallback}
	raw, err := json.Marshal(stored)
	if err != nil {
		h.fail(c, "DB_ERROR")
		return
	}
	version, err := h.store.CommitScene(h.ctx, shared, personal, raw)
	if err != nil {
		status = "error"
		log.Printf("save dialogue: %v", err)
		h.fail(c, "DB_ERROR")
		return
	}
	status = "completed"
	h.invalidateSceneViews(shared.NPCID)
	shared.Version = version
	shared.Reply = raw
	s.data = shared
	s.stored = &stored
	relation := shared.Relation
	c.turn = turnID(s)
	c.activeNPC = relation.NPCID
	c.choices = append([]game.Choice{}, e.reply.Choices...)
	speech := Speech{NPCID: relation.NPCID, PlayerID: c.player.ID, Tokens: e.reply.Tokens, Choices: c.choices, TurnID: c.turn, Emotion: e.reply.Emotion, Mianzi: relation.Mianzi, Aggro: relation.Aggro, Price: relation.Price, State: relation.State, Fallback: e.fallback, Offers: h.offers(relation.NPCID), SceneVersion: shared.Version}
	for _, observer := range h.nearby(npc.X, npc.Z, speechRadius) {
		if !game.Near(observer.player.X, observer.player.Z, npc.X, npc.Z, speechRadius) {
			continue
		}
		view := speech
		// All nearby participants may choose the current shared turn.
		if !game.Near(observer.player.X, observer.player.Z, npc.X, npc.Z, interactionRadius) {
			view.Choices = []game.Choice{}
			view.TurnID = ""
		}
		observer.speech = &view
		h.sendSpeech(observer, view)
		h.emit(observer, "NPC_STATE", h.state(s))
	}
}
func (h *Hub) sendSpeech(c *client, s Speech) {
	s.Tokens = game.Filter(s.Tokens, c.known)
	h.emit(c, "NPC_SPEECH", s)
}
func (h *Hub) inspect(c *client, raw []byte) {
	var v struct {
		ItemID   string `json:"item_id"`
		AnswerID *int   `json:"answer_id"`
		QuizID   string `json:"quiz_id"`
	}
	if Decode(raw, &v) != nil {
		h.fail(c, "INVALID_INSPECT")
		return
	}
	item, ok := h.catalog.Items[v.ItemID]
	if !ok || !game.Near(c.player.X, c.player.Z, item.X, item.Z, 5) {
		h.fail(c, "ITEM_OUT_OF_RANGE")
		return
	}
	if v.AnswerID == nil {
		if v.QuizID != "" {
			h.fail(c, "INVALID_INSPECT")
			return
		}
		c.quiz = rand.Text()
		c.quizItem = item.ID
		h.emit(c, "QUIZ", map[string]any{"quiz_id": c.quiz, "item_id": item.ID, "audio_text": h.catalog.Words[item.WordID].ZH, "options": item.Options})
		return
	}
	if v.QuizID == "" || v.QuizID != c.quiz || c.quizItem != item.ID {
		h.fail(c, "STALE_QUIZ")
		return
	}
	valid := false
	for _, o := range item.Options {
		valid = valid || o.ID == *v.AnswerID
	}
	if !valid {
		h.fail(c, "INVALID_ANSWER")
		return
	}
	if *v.AnswerID != item.AnswerID {
		c.quiz = ""
		c.quizItem = ""
		h.emit(c, "QUIZ_RESULT", map[string]any{"correct": false, "item_id": item.ID})
		return
	}
	learned, err := h.store.Learn(h.ctx, c.player.ID, item.WordID)
	if err != nil {
		log.Printf("learn word: %v", err)
		h.fail(c, "DB_ERROR")
		return
	}
	c.quiz = ""
	c.quizItem = ""
	c.known[item.WordID] = true
	h.emit(c, "QUIZ_RESULT", map[string]any{"correct": true, "item_id": item.ID, "new": learned})
	if learned {
		w := h.catalog.Words[item.WordID]
		h.emit(c, "WORD_LEARNED", map[string]string{"word_id": w.ID, "zh": w.ZH, "py": w.PY, "ru": w.RU})
	}
	if c.speech != nil {
		npc := h.catalog.NPCs[c.speech.NPCID]
		if game.Near(c.player.X, c.player.Z, npc.X, npc.Z, speechRadius) {
			scene, err := h.getScene(npc.ID)
			if err != nil {
				h.fail(c, "DB_ERROR")
				return
			}
			h.sendScene(c, scene)
		}
	}
}
