package db

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/mattn/go-sqlite3"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrations embed.FS
var ErrLoginTaken = errors.New("login already taken")

type Store struct{ SQL *sql.DB }
type Player struct {
	ID           int64   `json:"id"`
	Login        string  `json:"login"`
	PasswordHash string  `json:"-"`
	Profile      string  `json:"profile"`
	X            float64 `json:"x"`
	Z            float64 `json:"z"`
	Rotation     float64 `json:"rotation"`
	Balance      int     `json:"balance"`
}
type Item struct {
	ID        string `json:"item_id"`
	PricePaid int    `json:"price_paid"`
}
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Relation struct {
	NPCID    string    `json:"npc_id"`
	PlayerID int64     `json:"-"`
	State    string    `json:"state"`
	Mianzi   int       `json:"mianzi"`
	Aggro    int       `json:"aggro"`
	Price    int       `json:"price"`
	Floor    int       `json:"-"`
	History  []Message `json:"-"`
}

func Open(path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: abs}
	q := u.Query()
	q.Set("_foreign_keys", "on")
	q.Set("_journal_mode", "WAL")
	q.Set("_busy_timeout", "5000")
	q.Set("_synchronous", "FULL")
	u.RawQuery = q.Encode()
	d, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1)
	d.SetMaxIdleConns(1)
	s := &Store{SQL: d}
	if err = d.Ping(); err == nil {
		err = s.migrate()
	}
	if err != nil {
		d.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.SQL.Close() }
func (s *Store) migrate() error {
	tx, err := s.SQL.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"); err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		v, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return err
		}
		var exists int
		if err = tx.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version=?", v).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			continue
		}
		data, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		if _, err = tx.Exec(string(data)); err != nil {
			return fmt.Errorf("migration %d: %w", v, err)
		}
		if _, err = tx.Exec("INSERT INTO schema_migrations(version) VALUES(?)", v); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Register(ctx context.Context, login, hash, profile string, words []string) (Player, error) {
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return Player{}, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, "INSERT INTO players(login,password_hash,profile) VALUES(?,?,?)", strings.TrimSpace(login), hash, profile)
	if err != nil {
		var se sqlite3.Error
		if errors.As(err, &se) && se.ExtendedCode == sqlite3.ErrConstraintUnique {
			return Player{}, ErrLoginTaken
		}
		return Player{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Player{}, err
	}
	for _, w := range words {
		if _, err = tx.ExecContext(ctx, "INSERT INTO known_words(player_id,word_id) VALUES(?,?)", id, w); err != nil {
			return Player{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Player{}, err
	}
	return s.Player(ctx, id)
}

const playerCols = "id,login,password_hash,profile,pos_x,pos_z,rotation,balance"

func scanPlayer(row *sql.Row) (p Player, err error) {
	err = row.Scan(&p.ID, &p.Login, &p.PasswordHash, &p.Profile, &p.X, &p.Z, &p.Rotation, &p.Balance)
	return
}
func (s *Store) Player(ctx context.Context, id int64) (Player, error) {
	return scanPlayer(s.SQL.QueryRowContext(ctx, "SELECT "+playerCols+" FROM players WHERE id=?", id))
}
func (s *Store) ByLogin(ctx context.Context, login string) (Player, error) {
	return scanPlayer(s.SQL.QueryRowContext(ctx, "SELECT "+playerCols+" FROM players WHERE login=?", strings.TrimSpace(login)))
}
func (s *Store) SavePositions(ctx context.Context, ps []Player) error {
	if len(ps) == 0 {
		return nil
	}
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range ps {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET pos_x=?,pos_z=?,rotation=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", p.X, p.Z, p.Rotation, p.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Words(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT word_id FROM known_words WHERE player_id=? ORDER BY word_id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var w string
		if err = rows.Scan(&w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
func (s *Store) Inventory(ctx context.Context, id int64) ([]Item, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT item_id,price_paid FROM inventory WHERE player_id=? ORDER BY item_id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var i Item
		if err = rows.Scan(&i.ID, &i.PricePaid); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}
func (s *Store) Learn(ctx context.Context, id int64, word string) (bool, error) {
	res, err := s.SQL.ExecContext(ctx, "INSERT INTO known_words(player_id,word_id) VALUES(?,?) ON CONFLICT(player_id,word_id) DO NOTHING", id, word)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
func (s *Store) Relation(ctx context.Context, id int64, npc string, price, floor int) (Relation, error) {
	_, err := s.SQL.ExecContext(ctx, "INSERT INTO npc_relations(npc_id,player_id,current_price,price_floor) VALUES(?,?,?,?) ON CONFLICT(npc_id,player_id) DO NOTHING", npc, id, price, floor)
	if err != nil {
		return Relation{}, err
	}
	r := Relation{NPCID: npc, PlayerID: id}
	var history string
	err = s.SQL.QueryRowContext(ctx, "SELECT state,mianzi,aggro,current_price,price_floor,history_json FROM npc_relations WHERE npc_id=? AND player_id=?", npc, id).Scan(&r.State, &r.Mianzi, &r.Aggro, &r.Price, &r.Floor, &history)
	if err != nil {
		return r, err
	}
	err = json.Unmarshal([]byte(history), &r.History)
	return r, err
}
func (s *Store) SaveRelation(ctx context.Context, r Relation) error {
	b, err := json.Marshal(r.History)
	if err != nil {
		return err
	}
	_, err = s.SQL.ExecContext(ctx, "UPDATE npc_relations SET state=?,mianzi=?,aggro=?,current_price=?,price_floor=?,history_json=?,updated_at=CURRENT_TIMESTAMP WHERE npc_id=? AND player_id=?", r.State, r.Mianzi, r.Aggro, r.Price, r.Floor, string(b), r.NPCID, r.PlayerID)
	return err
}
