package game

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hackaton/server/internal/db"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
)

type Choice struct {
	ID   int    `json:"id"`
	ZH   string `json:"zh"`
	PY   string `json:"py"`
	RU   string `json:"ru"`
	Type string `json:"type"`
}
type Reply struct {
	Tokens      []Token  `json:"speech_tokens"`
	Emotion     string   `json:"emotion"`
	Price       int      `json:"price_new"`
	MianziDelta int      `json:"mianzi_delta"`
	AggroDelta  int      `json:"aggro_delta"`
	State       string   `json:"fsm_state"`
	Choices     []Choice `json:"choices"`
}
type AI struct {
	URL     string
	Client  *http.Client
	Catalog *Catalog
}

func NewAI(url string, c *Catalog) *AI {
	return &AI{URL: strings.TrimRight(url, "/"), Client: &http.Client{Timeout: 15 * time.Second}, Catalog: c}
}
func (a *AI) Request(ctx context.Context, r db.Relation, text string) (Reply, error) {
	return a.RequestScene(ctx, r, text, nil)
}
func (a *AI) RequestScene(ctx context.Context, r db.Relation, text string, sceneHistory []db.Message) (Reply, error) {
	body := map[string]any{"npc_id": r.NPCID, "player_message": text, "context": map[string]any{
		"price": r.Price, "price_floor": r.Floor, "mianzi": r.Mianzi, "aggro": r.Aggro, "history": r.History, "scene_history": sceneHistory, "npc_kind": a.Catalog.NPCs[r.NPCID].Kind,
	}}
	data, err := json.Marshal(body)
	if err != nil {
		return Reply{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", a.URL+"/dialogue", bytes.NewReader(data))
	if err != nil {
		return Reply{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := a.Client.Do(req)
	if err != nil {
		return Reply{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return Reply{}, fmt.Errorf("AI HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil {
		return Reply{}, err
	}
	if len(b) > 65536 {
		return Reply{}, fmt.Errorf("AI response too large")
	}
	var envelope struct {
		Parsed json.RawMessage `json:"parsed"`
	}
	if err = json.Unmarshal(b, &envelope); err != nil {
		return Reply{}, err
	}
	// Pointers distinguish valid zero deltas from missing model fields.
	var fields struct {
		Tokens  *[]Token  `json:"speech_tokens"`
		Emotion *string   `json:"emotion"`
		Price   *int      `json:"price_new"`
		Mianzi  *int      `json:"mianzi_delta"`
		Aggro   *int      `json:"aggro_delta"`
		State   *string   `json:"fsm_state"`
		Choices *[]Choice `json:"choices"`
	}
	if err = json.Unmarshal(envelope.Parsed, &fields); err != nil {
		return Reply{}, err
	}
	if fields.Tokens == nil || fields.Emotion == nil || fields.Price == nil || fields.Mianzi == nil || fields.Aggro == nil || fields.State == nil || fields.Choices == nil {
		return Reply{}, fmt.Errorf("missing AI fields")
	}
	reply := Reply{*fields.Tokens, *fields.Emotion, *fields.Price, *fields.Mianzi, *fields.Aggro, *fields.State, *fields.Choices}
	if err = a.validate(reply, r); err != nil {
		return Reply{}, err
	}
	return reply, nil
}
func validState(s string) bool {
	switch s {
	case "IDLE", "CALLING", "HAGGLING", "FLATTERED", "SUSPICIOUS", "AGGRO":
		return true
	}
	return false
}
func (a *AI) validate(p Reply, r db.Relation) error {
	if len(p.Tokens) == 0 || len(p.Tokens) > 64 || len(p.Choices) != 4 || !validState(p.State) || p.Price < r.Floor || p.Price > 100000 || p.MianziDelta < -30 || p.MianziDelta > 30 || p.AggroDelta < -30 || p.AggroDelta > 30 {
		return fmt.Errorf("invalid AI state")
	}
	switch p.Emotion {
	case "neutral", "angry", "happy", "suspicious":
	default:
		return fmt.Errorf("invalid AI emotion")
	}
	for _, t := range p.Tokens {
		if len(t.ZH) > 512 || len(t.PY) > 512 || len(t.RU) > 1024 || t.ZH == "" {
			return fmt.Errorf("invalid AI token")
		}
		if t.ID == "" {
			for _, ch := range t.ZH {
				if unicode.Is(unicode.Han, ch) {
					return fmt.Errorf("Chinese words require catalog IDs")
				}
			}
		}
		if t.ID != "" {
			w, ok := a.Catalog.Words[t.ID]
			if !ok || w.ZH != t.ZH || w.PY != t.PY || w.RU != t.RU {
				return fmt.Errorf("unknown or mismatched AI word %s", t.ID)
			}
		}
	}
	seen := map[int]bool{}
	for _, c := range p.Choices {
		if c.ID < 1 || seen[c.ID] || c.ZH == "" || c.PY == "" || c.RU == "" || len(c.ZH) > 512 || len(c.PY) > 512 || len(c.RU) > 1024 {
			return fmt.Errorf("invalid AI choices")
		}
		switch c.Type {
		case "polite", "haggle", "provoke", "leave", "bluff", "order", "documents", "bribe", "directions":
		default:
			return fmt.Errorf("invalid choice type")
		}
		seen[c.ID] = true
	}
	return nil
}
func Choices() []Choice {
	return []Choice{
		{1, "老板，便宜点吧！", "Lǎobǎn, piányi diǎn ba!", "Босс, сделай скидку!", "polite"},
		{2, "太贵了！", "Tài guì le!", "Слишком дорого!", "haggle"},
		{3, "这是假货！", "Zhè shì jiǎhuò!", "Это подделка!", "provoke"},
		{4, "对不起，我再看看。", "Duìbuqǐ, wǒ zài kànkan.", "Извините, я ещё посмотрю.", "leave"},
	}
}
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
func Fallback(r db.Relation, choice *Choice, c *Catalog) Reply {
	p := Reply{Emotion: "neutral", Price: r.Price, State: "HAGGLING", Choices: ChoicesFor(c.NPCs[r.NPCID].Kind)}
	switch {
	case choice == nil:
	case choice.Type == "polite" || choice.Type == "documents" || choice.Type == "order" || choice.Type == "directions":
		p.MianziDelta = 15
		p.AggroDelta = -15
		p.Price = r.Price * 9 / 10
	case choice.Type == "haggle" || choice.Type == "bluff":
		p.AggroDelta = 10
		p.Price = r.Price * 8 / 10
	case choice.Type == "provoke":
		p.AggroDelta = 25
		p.MianziDelta = -10
	case choice.Type == "leave":
		p.AggroDelta = -20
		p.State = "IDLE"
	}
	if p.Price < r.Floor {
		p.Price = r.Floor
	}
	p.Tokens = []Token{{ZH: fmt.Sprintf("Hello friend! Цена %d ¥. ", p.Price), RU: fmt.Sprintf("Друг мой! Цена %d ¥. ", p.Price)}, c.Words["word_expensive"], c.Words["word_jade"]}
	if len(r.History) > 0 {
		p.Tokens = append([]Token{{ZH: "Мы уже говорили, друг мой! ", RU: "Мы уже говорили, друг мой! "}}, p.Tokens...)
	}
	switch c.NPCs[r.NPCID].Kind {
	case "chef":
		p.Tokens = []Token{{ZH: "Повар Чэнь: заказ принят к обсуждению. ", RU: "Повар Чэнь: заказ принят к обсуждению. "}, c.Words["word_noodles"], c.Words["word_spicy"]}
	case "guard":
		p.Tokens = []Token{{ZH: "Охранник Чжан: предъявите билет и соблюдайте правила. ", RU: "Охранник Чжан: предъявите билет и соблюдайте правила. "}, c.Words["word_ticket"]}
		p.Price = r.Price
	}
	p = Enforce(p, r, choice, c.NPCs[r.NPCID])
	r = Apply(r, p)
	p.State = r.State
	if r.State == "AGGRO" {
		p.Emotion = "angry"
	} else if r.State == "FLATTERED" {
		p.Emotion = "happy"
	}
	return p
}
func Apply(r db.Relation, p Reply) db.Relation {
	r.Mianzi = clamp(r.Mianzi+p.MianziDelta, 0, 100)
	r.Aggro = clamp(r.Aggro+p.AggroDelta, 0, 100)
	r.Price = clamp(p.Price, r.Floor, 100000)
	r.State = p.State
	if r.Aggro > 75 {
		r.State = "AGGRO"
	} else if r.Mianzi > 70 && r.State != "IDLE" {
		r.State = "FLATTERED"
	}
	return r
}
func AppendHistory(r db.Relation, user string, p Reply) db.Relation {
	speech := ""
	for _, t := range p.Tokens {
		speech += t.ZH
	}
	r.History = append(r.History, db.Message{Role: "user", Content: user}, db.Message{Role: "assistant", Content: speech})
	if len(r.History) > 6 {
		r.History = append([]db.Message{}, r.History[len(r.History)-6:]...)
	}
	return r
}
