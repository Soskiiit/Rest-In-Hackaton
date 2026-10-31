package game

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
)

type Token struct {
	ID string `json:"id,omitempty"`
	ZH string `json:"zh"`
	PY string `json:"py"`
	RU string `json:"ru"`
}
type NPC struct {
	Kind  string  `json:"kind"`
	ID    string  `json:"id"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Price int     `json:"price"`
	Floor int     `json:"price_floor"`
}
type Option struct {
	ID int    `json:"id"`
	ZH string `json:"zh"`
	PY string `json:"py"`
	RU string `json:"ru"`
}
type InspectItem struct {
	ID       string   `json:"id"`
	X        float64  `json:"x"`
	Z        float64  `json:"z"`
	WordID   string   `json:"word_id"`
	AnswerID int      `json:"answer_id"`
	Options  []Option `json:"options"`
}
type Product struct {
	ID     string `json:"id"`
	NPCID  string `json:"npc_id"`
	WordID string `json:"word_id"`
}
type Catalog struct {
	Products map[string]Product     `json:"products"`
	Words    map[string]Token       `json:"words"`
	Profiles map[string][]string    `json:"profiles"`
	NPCs     map[string]NPC         `json:"npcs"`
	Items    map[string]InspectItem `json:"items"`
}

func Finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func Position(x, z float64) bool {
	return Finite(x) && Finite(z) && x >= 0 && z >= 0 && x < 200 && z < 200
}
func Near(x, z, ox, oz, radius float64) bool { return (x-ox)*(x-ox)+(z-oz)*(z-oz) <= radius*radius }
func LoadCatalog(path string) (*Catalog, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Catalog
	if err = json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if len(c.Words) == 0 || len(c.NPCs) == 0 || len(c.Items) == 0 {
		return nil, fmt.Errorf("empty catalog")
	}
	for id, w := range c.Words {
		if id != w.ID || w.ZH == "" || w.PY == "" || w.RU == "" {
			return nil, fmt.Errorf("invalid word %s", id)
		}
	}
	for _, p := range []string{"business", "culture"} {
		if len(c.Profiles[p]) == 0 {
			return nil, fmt.Errorf("missing profile %s", p)
		}
		seen := map[string]bool{}
		for _, w := range c.Profiles[p] {
			if _, ok := c.Words[w]; !ok || seen[w] {
				return nil, fmt.Errorf("invalid profile word %s", w)
			}
			seen[w] = true
		}
	}
	for id, n := range c.NPCs {
		if n.Kind == "" {
			n.Kind = "merchant"
			c.NPCs[id] = n
		}
		if n.Kind != "merchant" && n.Kind != "chef" && n.Kind != "guard" {
			return nil, fmt.Errorf("invalid NPC kind %s", id)
		}
		if id == "" || id != n.ID || !Position(n.X, n.Z) || n.Price < n.Floor || n.Floor < 0 || n.Price > 100000 {
			return nil, fmt.Errorf("invalid NPC %s", id)
		}
	}
	for id, i := range c.Items {
		if _, ok := c.Words[i.WordID]; !ok {
			return nil, fmt.Errorf("unknown item word %s", id)
		}
		if id == "" || id != i.ID || !Position(i.X, i.Z) || len(i.Options) != 4 {
			return nil, fmt.Errorf("invalid item %s", id)
		}
		seen := map[int]bool{}
		found := false
		for _, o := range i.Options {
			if o.ID < 1 || seen[o.ID] || o.ZH == "" || o.PY == "" || o.RU == "" {
				return nil, fmt.Errorf("invalid quiz options")
			}
			seen[o.ID] = true
			if o.ID == i.AnswerID {
				word := c.Words[i.WordID]
				if o.ZH != word.ZH || o.PY != word.PY || o.RU != word.RU {
					return nil, fmt.Errorf("correct quiz option does not match item word %s", id)
				}
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("missing correct option")
		}
	}
	for id, p := range c.Products {
		npc, ok := c.NPCs[p.NPCID]
		item, itemOK := c.Items[id]
		if !ok || !itemOK || id != p.ID || npc.Kind == "guard" || p.WordID != item.WordID || !Near(item.X, item.Z, npc.X, npc.Z, 5) {
			return nil, fmt.Errorf("invalid product %s", id)
		}
	}
	return &c, nil
}
func Filter(tokens []Token, known map[string]bool) []Token {
	result := append([]Token{}, tokens...)
	for i, t := range result {
		if t.ID != "" && !known[t.ID] {
			result[i].RU = "[???]"
		}
	}
	return result
}
