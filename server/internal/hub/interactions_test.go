package hub

import (
	"context"
	"encoding/json"
	"hackaton/server/internal/testdb"
	"testing"
	"time"

	"hackaton/server/internal/db"
	"hackaton/server/internal/game"
)

func TestObservedSpeechDoesNotInvalidateOwnDialogue(t *testing.T) {
	catalog, err := game.LoadCatalog("../../world/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	store, err := db.Open(testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	player, err := store.Register(context.Background(), "alice", "test-hash", "business", nil)
	if err != nil {
		t.Fatal(err)
	}
	player.X, player.Z = 100, 124
	c := &client{player: player, ctx: context.Background(), done: make(chan struct{}), send: make(chan []byte, 16),
		expires: time.Now().Add(time.Hour), known: map[string]bool{}, activeNPC: "lao_wang",
		turn: "own-valid-turn", choices: game.Choices(), speech: &Speech{NPCID: "another_npc"}}
	h := &Hub{store: store, catalog: catalog, ai: game.NewAI("http://127.0.0.1:1", catalog),
		ctx: context.Background(), done: make(chan struct{}), events: make(chan any, 16), clients: map[int64]*client{player.ID: c}}
	scene, err := h.getScene("lao_wang")
	if err != nil {
		t.Fatal(err)
	}
	scene.stored = &storedReply{Reply: game.Fallback(scene.data.Relation, nil, catalog)}
	c.turn = turnID(scene)
	oldTurn := c.turn
	payload, _ := json.Marshal(map[string]any{"npc_id": "lao_wang", "choice_id": 1, "turn_id": c.turn})
	h.dialogue(c, payload)
	if !c.pending {
		t.Fatal("hearing another NPC invalidated the player's active choice")
	}
	h.wg.Wait()
	var foundDone bool
	for !foundDone {
		select {
		case raw := <-h.events:
			if e, ok := raw.(aiDone); ok {
				foundDone = true
				h.finishDialogue(e)
			} else if p, ok := raw.(aiPartial); ok {
				h.partialDialogue(p)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("dialogue did not complete")
		}
	}
	if c.activeNPC != "lao_wang" || c.turn == oldTurn || c.pending {
		t.Fatal("active conversation did not advance")
	}
	relation, err := store.Relation(context.Background(), player.ID, "lao_wang", 800, 120)
	if err != nil || relation.Mianzi != 65 || len(relation.History) != 2 {
		t.Fatalf("choice was not persisted: %+v %v", relation, err)
	}
}
