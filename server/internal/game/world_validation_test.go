package game

import (
	"encoding/json"
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
	for _, mode := range []string{"missing", "unknown", "position", "duplicate"} {
		t.Run(mode, func(t *testing.T) {
			chunk := original
			chunk.Items = append([]ItemRef{}, original.Items...)
			switch mode {
			case "missing":
				chunk.Items = []ItemRef{}
			case "unknown":
				chunk.Items[0].ID = "unknown"
			case "position":
				chunk.Items[0].X++
			case "duplicate":
				chunk.Items = append(chunk.Items, chunk.Items[0])
			}
			data, err := json.Marshal(chunk)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(dir, "5_6.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = LoadWorld(dir, catalog); err == nil {
				t.Fatalf("%s item placement accepted", mode)
			}
		})
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
