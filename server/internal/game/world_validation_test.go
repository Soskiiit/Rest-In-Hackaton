package game

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestWorldExposesItemsAndValidatesPlacement(t *testing.T) {
	catalog := testCatalog(t)
	world, err := LoadWorld("../../world/chunks", catalog)
	if err != nil {
		t.Fatal(err)
	}
	items := world.Chunks["5_6"].Items
	if len(items) != 2 || items[0].ID != "teapot" || items[0].X != 1 || items[0].Z != 4 {
		t.Fatalf("client cannot discover the inspectable item: %+v", items)
	}
	dir := t.TempDir()
	entries, err := os.ReadDir("../../world/chunks")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join("../../world/chunks", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, entry.Name()), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	original := world.Chunks["5_6"]
	write := func(t *testing.T, chunk Chunk) {
		t.Helper()
		data, err := json.Marshal(chunk)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "5_6.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Soft rules: the level editor may move, remove, duplicate or add unknown items; the server still starts.
	for _, tc := range []struct {
		mode   string
		edit   func(c *Chunk)
		placed bool
		x      float64
	}{
		{"position", func(c *Chunk) { c.Items[0].X++ }, true, 102},
		{"missing", func(c *Chunk) { c.Items = []ItemRef{} }, false, 0},
		{"unknown", func(c *Chunk) { c.Items[0].ID = "unknown" }, false, 0},
		{"duplicate", func(c *Chunk) { c.Items = append(c.Items, ItemRef{ID: "teapot", X: 9, Z: 9}) }, true, 101},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			chunk := original
			chunk.Items = append([]ItemRef{}, original.Items...)
			tc.edit(&chunk)
			write(t, chunk)
			w, err := LoadWorld(dir, catalog)
			if err != nil {
				t.Fatalf("%s: server must still start: %v", tc.mode, err)
			}
			pos, ok := w.Items["teapot"]
			if ok != tc.placed || (ok && pos.X != tc.x) {
				t.Fatalf("%s: teapot placed=%v at %+v", tc.mode, ok, pos)
			}
		})
	}
	t.Run("outside chunk", func(t *testing.T) {
		chunk := original
		chunk.Items = append([]ItemRef{}, original.Items...)
		chunk.Items[0].X = 25
		write(t, chunk)
		if _, err := LoadWorld(dir, catalog); err == nil {
			t.Fatal("item outside its chunk accepted")
		}
	})
}

func TestWorldReloadMovesNPCsAndItems(t *testing.T) {
	catalog := testCatalog(t)
	dir := t.TempDir()
	entries, err := os.ReadDir("../../world/chunks")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join("../../world/chunks", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, entry.Name()), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	world, err := LoadWorld(dir, catalog)
	if err != nil {
		t.Fatal(err)
	}
	placed := world.PlaceCatalog(catalog)
	if placed.NPCs["lao_wang"].X != 100 || placed.NPCs["lao_wang"].Z != 124 {
		t.Fatalf("lao_wang starts at %+v", placed.NPCs["lao_wang"])
	}
	chunk := world.Chunks["5_6"]
	chunk.NPCs = []NPCRef{{ID: "lao_wang", X: 10, Z: 10}}
	chunk.Items = []ItemRef{{ID: "jade_amulet", X: 11, Z: 10, Y: 1}} // teapot removed
	data, _ := json.Marshal(chunk)
	if err = os.WriteFile(filepath.Join(dir, "5_6.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err = world.Reload([]string{"5_6"}, catalog); err != nil {
		t.Fatal(err)
	}
	moved := world.PlaceCatalog(placed)
	if moved.NPCs["lao_wang"].X != 110 || moved.NPCs["lao_wang"].Z != 130 {
		t.Fatalf("lao_wang not moved: %+v", moved.NPCs["lao_wang"])
	}
	if teapot := moved.Items["teapot"]; !math.IsNaN(teapot.X) || Near(101, 124, teapot.X, teapot.Z, 100) {
		t.Fatalf("removed teapot is still reachable: %+v", teapot)
	}
	if placed.NPCs["lao_wang"].X != 100 {
		t.Fatal("PlaceCatalog changed the previous catalog in place")
	}
	before := world.Chunks["5_6"]
	if err = os.WriteFile(filepath.Join(dir, "5_6.json"), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = world.Reload([]string{"5_6"}, catalog); err == nil {
		t.Fatal("broken chunk accepted")
	}
	if len(world.Chunks["5_6"].NPCs) != len(before.NPCs) || world.NPCs["lao_wang"].X != 110 {
		t.Fatal("failed reload changed the world")
	}
}

func TestCatalogRejectsQuizWithWrongCorrectWord(t *testing.T) {
	catalog := testCatalog(t)
	item := catalog.Items["teapot"]
	item.AnswerID = 2
	catalog.Items["teapot"] = item
	data, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "catalog.json")
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LoadCatalog(path); err == nil {
		t.Fatal("quiz accepted a correct answer unrelated to the item")
	}
}
