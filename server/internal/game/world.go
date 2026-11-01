package game

import (
	"encoding/json"
	"fmt"
	"log"
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

// World is the server copy of the chunk files. Chunk files are the source of truth for where
// catalog NPCs and items stand: the level editor may move, remove or duplicate them at any time.
type World struct {
	Dir        string
	Chunks     map[string]Chunk
	Sizes      map[string]int
	TotalBytes int
	Revisions  map[string]int64
	NPCs       map[string]Vec3 // world position of each placed catalog NPC
	Items      map[string]Vec3 // world position of each placed catalog item
}

func local(x, z float64) bool { return Finite(x) && Finite(z) && x >= 0 && z >= 0 && x < 20 && z < 20 }

// parseChunk checks the chunk structure and returns it with its canonical JSON size.
func parseChunk(id string, b []byte) (Chunk, int, error) {
	var c Chunk
	if err := json.Unmarshal(b, &c); err != nil {
		return c, 0, fmt.Errorf("chunk %s: %w", id, err)
	}
	if c.ID != id || c.Buildings == nil || c.Lanterns == nil || c.Signs == nil || c.NPCs == nil || c.Items == nil {
		return c, 0, fmt.Errorf("invalid chunk %s", id)
	}
	for _, o := range c.Buildings {
		if o.Type == "" || !local(o.X, o.Z) {
			return c, 0, fmt.Errorf("invalid building %s", id)
		}
	}
	for _, o := range c.Lanterns {
		if !local(o.X, o.Z) || !Finite(o.Y) {
			return c, 0, fmt.Errorf("invalid lantern %s", id)
		}
	}
	for _, o := range c.Signs {
		if !local(o.X, o.Z) || !Finite(o.Y) || o.Text == "" {
			return c, 0, fmt.Errorf("invalid sign %s", id)
		}
	}
	for _, o := range c.NPCs {
		if o.ID == "" || !local(o.X, o.Z) || !Finite(o.Y) {
			return c, 0, fmt.Errorf("invalid NPC %s", id)
		}
	}
	for _, o := range c.Items {
		if o.ID == "" || !local(o.X, o.Z) || !Finite(o.Y) {
			return c, 0, fmt.Errorf("invalid item %s", id)
		}
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return c, 0, err
	}
	return c, len(raw), nil
}

// placements finds where catalog NPCs and items stand. Unknown ids are decoration, the first copy of a
// duplicate wins, and a catalog entry that is not placed anywhere is simply unavailable.
func placements(chunks map[string]Chunk, catalog *Catalog) (map[string]Vec3, map[string]Vec3) {
	ids := make([]string, 0, len(chunks))
	for id := range chunks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	npcs, items := map[string]Vec3{}, map[string]Vec3{}
	for _, id := range ids {
		var cx, cz int
		fmt.Sscanf(id, "%d_%d", &cx, &cz)
		for _, o := range chunks[id].NPCs {
			if _, ok := catalog.NPCs[o.ID]; !ok {
				log.Printf("world: NPC %q in chunk %s is not in the catalog, kept as decoration", o.ID, id)
			} else if _, dup := npcs[o.ID]; dup {
				log.Printf("world: NPC %q placed again in chunk %s, the first placement is used", o.ID, id)
			} else {
				npcs[o.ID] = Vec3{X: float64(cx*20) + o.X, Y: o.Y, Z: float64(cz*20) + o.Z}
			}
		}
		for _, o := range chunks[id].Items {
			if _, ok := catalog.Items[o.ID]; !ok {
				log.Printf("world: item %q in chunk %s is not in the catalog, kept as decoration", o.ID, id)
			} else if _, dup := items[o.ID]; dup {
				log.Printf("world: item %q placed again in chunk %s, the first placement is used", o.ID, id)
			} else {
				items[o.ID] = Vec3{X: float64(cx*20) + o.X, Y: o.Y, Z: float64(cz*20) + o.Z}
			}
		}
	}
	for id := range catalog.NPCs {
		if _, ok := npcs[id]; !ok {
			log.Printf("world: NPC %q is not placed in any chunk and is unavailable", id)
		}
	}
	for id := range catalog.Items {
		if _, ok := items[id]; !ok {
			log.Printf("world: item %q is not placed in any chunk and is unavailable", id)
		}
	}
	return npcs, items
}

func budget(sizes map[string]int) (int, error) {
	total := 0
	for _, size := range sizes {
		total += size
	}
	for id, size := range sizes {
		if size*10 > total {
			return 0, fmt.Errorf("chunk %s alone exceeds 10%% data budget", id)
		}
	}
	return total, nil
}

func LoadWorld(dir string, catalog *Catalog) (*World, error) {
	w := &World{Dir: dir, Chunks: map[string]Chunk{}, Sizes: map[string]int{}}
	for x := 0; x < 10; x++ {
		for z := 0; z < 10; z++ {
			id := fmt.Sprintf("%d_%d", x, z)
			b, err := os.ReadFile(filepath.Join(dir, id+".json"))
			if err != nil {
				return nil, err
			}
			c, size, err := parseChunk(id, b)
			if err != nil {
				return nil, err
			}
			w.Chunks[id] = c
			w.Sizes[id] = size
		}
	}
	total, err := budget(w.Sizes)
	if err != nil {
		return nil, err
	}
	w.TotalBytes = total
	w.NPCs, w.Items = placements(w.Chunks, catalog)
	return w, nil
}

// LoadWorldData restores the complete authoritative world without reading chunk files.
func LoadWorldData(dir string, chunks map[string]json.RawMessage, catalog *Catalog) (*World, error) {
	if len(chunks) != 100 {
		return nil, fmt.Errorf("world must contain 100 chunks")
	}
	w := &World{Dir: dir, Chunks: map[string]Chunk{}, Sizes: map[string]int{}, Revisions: map[string]int64{}}
	for x := 0; x < 10; x++ {
		for z := 0; z < 10; z++ {
			id := fmt.Sprintf("%d_%d", x, z)
			data, ok := chunks[id]
			if !ok {
				return nil, fmt.Errorf("missing chunk %s", id)
			}
			chunk, size, err := parseChunk(id, data)
			if err != nil {
				return nil, err
			}
			w.Chunks[id], w.Sizes[id] = chunk, size
		}
	}
	total, err := budget(w.Sizes)
	if err != nil {
		return nil, err
	}
	w.TotalBytes = total
	w.NPCs, w.Items = placements(w.Chunks, catalog)
	return w, nil
}

// Reload re-reads the given chunk files (saved by the level editor) and applies them all or nothing.
func (w *World) Reload(ids []string, catalog *Catalog) error {
	chunks := make(map[string]Chunk, len(w.Chunks))
	sizes := make(map[string]int, len(w.Sizes))
	for id, c := range w.Chunks {
		chunks[id] = c
		sizes[id] = w.Sizes[id]
	}
	for _, id := range ids {
		if _, ok := w.Chunks[id]; !ok {
			return fmt.Errorf("unknown chunk %s", id)
		}
		b, err := os.ReadFile(filepath.Join(w.Dir, id+".json"))
		if err != nil {
			return err
		}
		c, size, err := parseChunk(id, b)
		if err != nil {
			return err
		}
		chunks[id] = c
		sizes[id] = size
	}
	total, err := budget(sizes)
	if err != nil {
		return err
	}
	w.Chunks, w.Sizes, w.TotalBytes = chunks, sizes, total
	w.NPCs, w.Items = placements(chunks, catalog)
	return nil
}

// Updated validates a complete candidate without mutating the active world.
func (w *World) Updated(updates map[string]json.RawMessage, catalog *Catalog) (*World, error) {
	next := &World{Dir: w.Dir, Chunks: make(map[string]Chunk, len(w.Chunks)), Sizes: make(map[string]int, len(w.Sizes)), Revisions: make(map[string]int64, len(w.Chunks))}
	for id, chunk := range w.Chunks {
		next.Chunks[id] = chunk
		next.Sizes[id] = w.Sizes[id]
		next.Revisions[id] = w.Revisions[id]
	}
	for id, data := range updates {
		if _, ok := w.Chunks[id]; !ok {
			return nil, fmt.Errorf("unknown chunk %s", id)
		}
		chunk, size, err := parseChunk(id, data)
		if err != nil {
			return nil, err
		}
		next.Chunks[id] = chunk
		next.Sizes[id] = size
	}
	total, err := budget(next.Sizes)
	if err != nil {
		return nil, err
	}
	next.TotalBytes = total
	next.NPCs, next.Items = placements(next.Chunks, catalog)
	return next, nil
}

// PlaceCatalog returns a copy of the catalog with NPC and item positions taken from the world.
// An entry that is not placed gets NaN coordinates, so every distance check fails for it.
// The copy is new, so goroutines still holding the previous catalog never race with the hub.
func (w *World) PlaceCatalog(c *Catalog) *Catalog {
	placed := *c
	placed.NPCs = make(map[string]NPC, len(c.NPCs))
	for id, npc := range c.NPCs {
		pos, ok := w.NPCs[id]
		if !ok {
			pos = Vec3{X: math.NaN(), Z: math.NaN()}
		}
		npc.X, npc.Z = pos.X, pos.Z
		placed.NPCs[id] = npc
	}
	placed.Items = make(map[string]InspectItem, len(c.Items))
	for id, item := range c.Items {
		pos, ok := w.Items[id]
		if !ok {
			pos = Vec3{X: math.NaN(), Z: math.NaN()}
		}
		item.X, item.Z = pos.X, pos.Z
		placed.Items[id] = item
	}
	return &placed
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
