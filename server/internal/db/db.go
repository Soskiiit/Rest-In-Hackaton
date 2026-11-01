// Package db stores authoritative game state in PostgreSQL.
package db

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"sort"
	"strconv"
	"strings"
	"time"
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
	IsAdmin      bool    `json:"is_admin"`
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

func Open(dsn string) (*Store, error) {
	if !strings.HasPrefix(dsn, "postgres://") && !strings.HasPrefix(dsn, "postgresql://") {
		return nil, errors.New("DATABASE_URL must be a PostgreSQL URL")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid DATABASE_URL")
	}
	config.ConnectTimeout = 5 * time.Second
	config.RuntimeParams["application_name"] = "rest-in-hackaton"
	config.RuntimeParams["statement_timeout"] = "10000"
	config.RuntimeParams["lock_timeout"] = "5000"
	d := stdlib.OpenDB(*config)
	d.SetMaxOpenConns(10)
	d.SetMaxIdleConns(2)
	d.SetConnMaxIdleTime(5 * time.Minute)
	d.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = d.PingContext(ctx); err != nil {
		d.Close()
		return nil, fmt.Errorf("PostgreSQL connection failed: %w", err)
	}
	s := &Store{SQL: d}
	if err = s.migrate(); err != nil {
		d.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.SQL.Close() }
func (s *Store) migrate() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SET LOCAL statement_timeout='30s'"); err != nil {
		return err
	}
	// One transaction-scoped lock prevents two server starts applying the same DDL.
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(824009201)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"); err != nil {
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
		var exists bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", v).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		script, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(script)); err != nil {
			return fmt.Errorf("migration %d: %w", v, err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", v); err != nil {
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
	var id int64
	err = tx.QueryRowContext(ctx, "INSERT INTO players(login,password_hash,profile) VALUES($1,$2,$3) RETURNING id", strings.TrimSpace(login), hash, profile).Scan(&id)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "players_login_key" {
			return Player{}, ErrLoginTaken
		}
		return Player{}, err
	}
	for _, word := range words {
		if _, err = tx.ExecContext(ctx, "INSERT INTO known_words(player_id,word_id) VALUES($1,$2)", id, word); err != nil {
			return Player{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Player{}, err
	}
	return s.Player(ctx, id)
}

const playerCols = "id,login,password_hash,profile,pos_x,pos_z,rotation,balance,is_admin"

func scanPlayer(row *sql.Row) (p Player, err error) {
	err = row.Scan(&p.ID, &p.Login, &p.PasswordHash, &p.Profile, &p.X, &p.Z, &p.Rotation, &p.Balance, &p.IsAdmin)
	return
}
func (s *Store) Player(ctx context.Context, id int64) (Player, error) {
	return scanPlayer(s.SQL.QueryRowContext(ctx, "SELECT "+playerCols+" FROM players WHERE id=$1", id))
}
func (s *Store) ByLogin(ctx context.Context, login string) (Player, error) {
	return scanPlayer(s.SQL.QueryRowContext(ctx, "SELECT "+playerCols+" FROM players WHERE login=$1", strings.TrimSpace(login)))
}
func (s *Store) SavePositions(ctx context.Context, players []Player) error {
	if len(players) == 0 {
		return nil
	}
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	players = append([]Player{}, players...)
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	// Lock multiple wallets in ID order during position flushes.
	for _, p := range players {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET pos_x=$1,pos_z=$2,rotation=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4", p.X, p.Z, p.Rotation, p.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Words(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT word_id FROM known_words WHERE player_id=$1 ORDER BY word_id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var word string
		if err = rows.Scan(&word); err != nil {
			return nil, err
		}
		out = append(out, word)
	}
	return out, rows.Err()
}
func (s *Store) Inventory(ctx context.Context, id int64) ([]Item, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT item_id,price_paid FROM inventory WHERE player_id=$1 ORDER BY item_id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var item Item
		if err = rows.Scan(&item.ID, &item.PricePaid); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (s *Store) Learn(ctx context.Context, id int64, word string) (bool, error) {
	res, err := s.SQL.ExecContext(ctx, "INSERT INTO known_words(player_id,word_id) VALUES($1,$2) ON CONFLICT(player_id,word_id) DO NOTHING", id, word)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
func (s *Store) Relation(ctx context.Context, id int64, npc string, price, floor int) (Relation, error) {
	_, err := s.SQL.ExecContext(ctx, "INSERT INTO npc_relations(npc_id,player_id,current_price,price_floor) VALUES($1,$2,$3,$4) ON CONFLICT(npc_id,player_id) DO NOTHING", npc, id, price, floor)
	if err != nil {
		return Relation{}, err
	}
	r := Relation{NPCID: npc, PlayerID: id}
	var history []byte
	err = s.SQL.QueryRowContext(ctx, "SELECT state,mianzi,aggro,current_price,price_floor,history_json FROM npc_relations WHERE npc_id=$1 AND player_id=$2", npc, id).Scan(&r.State, &r.Mianzi, &r.Aggro, &r.Price, &r.Floor, &history)
	if err != nil {
		return r, err
	}
	err = json.Unmarshal(history, &r.History)
	return r, err
}
func (s *Store) SaveRelation(ctx context.Context, r Relation) error {
	history, err := json.Marshal(r.History)
	if err != nil {
		return err
	}
	_, err = s.SQL.ExecContext(ctx, "UPDATE npc_relations SET state=$1,mianzi=$2,aggro=$3,current_price=$4,price_floor=$5,history_json=$6::jsonb,updated_at=CURRENT_TIMESTAMP WHERE npc_id=$7 AND player_id=$8", r.State, r.Mianzi, r.Aggro, r.Price, r.Floor, string(history), r.NPCID, r.PlayerID)
	return err
}
