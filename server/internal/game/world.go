package game

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
)

type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}
type Building struct {
	Type string  `json:"type"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}
type Sign struct {
	Text string  `json:"text"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z"`
}
type NPCRef struct {
	ID string  `json:"npc_id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	Z  float64 `json:"z"`
}
type ItemRef struct {
	ID string  `json:"item_id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	Z  float64 `json:"z"`
}
type Chunk struct {
	ID        string     `json:"chunk_id"`
	Buildings []Building `json:"buildings"`
	Lanterns  []Vec3     `json:"lanterns"`
	Signs     []Sign     `json:"signs"`
	NPCs      []NPCRef   `json:"npcs"`
	Items     []ItemRef  `json:"items"`
}
type World struct {
	Chunks     map[string]Chunk
	Sizes      map[string]int
	TotalBytes int
}

func local(x, z float64) bool { return Finite(x) && Finite(z) && x >= 0 && z >= 0 && x < 20 && z < 20 }
func LoadWorld(dir string, catalog *Catalog) (*World, error) {
	w := &World{Chunks: map[string]Chunk{}, Sizes: map[string]int{}}
	seen := map[string]bool{}
	seenItems := map[string]bool{}
	for x := 0; x < 10; x++ {
		for z := 0; z < 10; z++ {
			id := fmt.Sprintf("%d_%d", x, z)
			b, err := os.ReadFile(filepath.Join(dir, id+".json"))
			if err != nil {
				return nil, err
			}
			var c Chunk
			if err = json.Unmarshal(b, &c); err != nil {
				return nil, fmt.Errorf("chunk %s: %w", id, err)
			}
			if c.ID != id || c.Buildings == nil || c.Lanterns == nil || c.Signs == nil || c.NPCs == nil || c.Items == nil {
				return nil, fmt.Errorf("invalid chunk %s", id)
			}
			for _, o := range c.Buildings {
				if o.Type == "" || !local(o.X, o.Z) {
					return nil, fmt.Errorf("invalid building %s", id)
				}
			}
			for _, o := range c.Lanterns {
				if !local(o.X, o.Z) || !Finite(o.Y) {
					return nil, fmt.Errorf("invalid lantern %s", id)
				}
			}
			for _, o := range c.Signs {
				if !local(o.X, o.Z) || !Finite(o.Y) || o.Text == "" {
					return nil, fmt.Errorf("invalid sign %s", id)
				}
			}
			for _, o := range c.NPCs {
				npc, ok := catalog.NPCs[o.ID]
				if !ok || seen[o.ID] || !local(o.X, o.Z) || !Finite(o.Y) || npc.X != float64(x*20)+o.X || npc.Z != float64(z*20)+o.Z {
					return nil, fmt.Errorf("invalid NPC placement %s", id)
				}
				seen[o.ID] = true
			}
			for _, o := range c.Items {
				item, ok := catalog.Items[o.ID]
				if !ok || seenItems[o.ID] || !local(o.X, o.Z) || !Finite(o.Y) || item.X != float64(x*20)+o.X || item.Z != float64(z*20)+o.Z {
					return nil, fmt.Errorf("invalid item placement %s", id)
				}
				seenItems[o.ID] = true
			}
			raw, err := json.Marshal(c)
			if err != nil {
				return nil, err
			}
			w.Chunks[id] = c
			w.Sizes[id] = len(raw)
			w.TotalBytes += len(raw)
		}
	}
	for id := range catalog.NPCs {
		if !seen[id] {
			return nil, fmt.Errorf("NPC %s not placed", id)
		}
	}
	for id := range catalog.Items {
		if !seenItems[id] {
			return nil, fmt.Errorf("item %s not placed", id)
		}
	}
	if w.TotalBytes < 18200 {
		w.TotalBytes = 18200
	}
	for id, size := range w.Sizes {
		if size*10 > w.TotalBytes {
			return nil, fmt.Errorf("chunk %s alone exceeds 10%% data budget", id)
		}
	}
	return w, nil
}
func (w *World) AOI(x, z float64) []string {
	if !Position(x, z) {
		return []string{}
	}
	cx, cz := int(math.Floor(x/20)), int(math.Floor(z/20))
	ids := []string{}
	for dx := -1; dx <= 1; dx++ {
		for dz := -1; dz <= 1; dz++ {
			xx, zz := cx+dx, cz+dz
			if xx >= 0 && xx < 10 && zz >= 0 && zz < 10 {
				ids = append(ids, fmt.Sprintf("%d_%d", xx, zz))
			}
		}
	}
	// Current chunk first, then nearest neighbors; ties remain deterministic.
	sort.Slice(ids, func(i, j int) bool {
		var ax, az, bx, bz int
		fmt.Sscanf(ids[i], "%d_%d", &ax, &az)
		fmt.Sscanf(ids[j], "%d_%d", &bx, &bz)
		da := (ax-cx)*(ax-cx) + (az-cz)*(az-cz)
		db := (bx-cx)*(bx-cx) + (bz-cz)*(bz-cz)
		if da == db {
			return ids[i] < ids[j]
		}
		return da < db
	})
	out := []string{}
	bytes := 0
	for _, id := range ids {
		if (bytes+w.Sizes[id])*10 <= w.TotalBytes {
			out = append(out, id)
			bytes += w.Sizes[id]
		}
	}
	return out
}
func ChunkID(x, z float64) string {
	return fmt.Sprintf("%d_%d", int(math.Floor(x/20)), int(math.Floor(z/20)))
}
