package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrStale = errors.New("STALE_TRADE")
	ErrFunds = errors.New("INSUFFICIENT_FUNDS")
	ErrOwned = errors.New("ITEM_ALREADY_OWNED")
	ErrTrade = errors.New("INVALID_TRADE")
)

type Scene struct {
	Relation
	Version int64
	Reply   json.RawMessage
}
type Receipt struct {
	TradeID      string `json:"trade_id"`
	PlayerID     int64  `json:"player_id"`
	NPCID        string `json:"npc_id"`
	ItemID       string `json:"item_id"`
	Amount       int    `json:"amount"`
	BalanceAfter int    `json:"balance_after"`
}

func (s *Store) Scene(ctx context.Context, npc string, price, floor int) (Scene, error) {
	_, err := s.SQL.ExecContext(ctx, "INSERT INTO npc_scenes(npc_id,current_price,price_floor) VALUES($1,$2,$3) ON CONFLICT(npc_id) DO NOTHING", npc, price, floor)
	if err != nil {
		return Scene{}, err
	}
	out := Scene{Relation: Relation{NPCID: npc}}
	var history, reply []byte
	err = s.SQL.QueryRowContext(ctx, "SELECT state,mianzi,aggro,current_price,price_floor,history_json,version,reply_json FROM npc_scenes WHERE npc_id=$1", npc).Scan(&out.State, &out.Mianzi, &out.Aggro, &out.Price, &out.Floor, &history, &out.Version, &reply)
	if err != nil {
		return out, err
	}
	out.Reply = json.RawMessage(reply)
	err = json.Unmarshal(history, &out.History)
	return out, err
}

// CommitScene atomically saves the shared turn and the acting player's private memory.
func (s *Store) CommitScene(ctx context.Context, scene Scene, personal Relation, reply json.RawMessage) (int64, error) {
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	history, err := json.Marshal(scene.History)
	if err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, "UPDATE npc_scenes SET state=$1,mianzi=$2,aggro=$3,current_price=$4,history_json=$5::jsonb,reply_json=$6::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE npc_id=$7 AND version=$8", scene.State, scene.Mianzi, scene.Aggro, scene.Price, string(history), string(reply), scene.NPCID, scene.Version)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n != 1 {
		return 0, ErrStale
	}
	history, err = json.Marshal(personal.History)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO npc_relations(npc_id,player_id,state,mianzi,aggro,current_price,price_floor,history_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(npc_id,player_id) DO UPDATE SET state=excluded.state,mianzi=excluded.mianzi,aggro=excluded.aggro,current_price=excluded.current_price,price_floor=excluded.price_floor,history_json=excluded.history_json,updated_at=CURRENT_TIMESTAMP", personal.NPCID, personal.PlayerID, personal.State, personal.Mianzi, personal.Aggro, personal.Price, personal.Floor, string(history))
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return scene.Version + 1, nil
}

const receiptColumns = "trade_id,player_id,npc_id,item_id,amount,balance_after"

func scanReceipt(row *sql.Row) (r Receipt, err error) {
	err = row.Scan(&r.TradeID, &r.PlayerID, &r.NPCID, &r.ItemID, &r.Amount, &r.BalanceAfter)
	return
}
func (s *Store) Receipt(ctx context.Context, player int64, id string) (Receipt, error) {
	return scanReceipt(s.SQL.QueryRowContext(ctx, "SELECT "+receiptColumns+" FROM purchases WHERE player_id=$1 AND trade_id=$2", player, id))
}
func (s *Store) Buy(ctx context.Context, player int64, trade, npc, item string, amount int, version int64) (Receipt, bool, error) {
	if amount < 1 || amount > 100000 || trade == "" || item == "" {
		return Receipt{}, false, ErrTrade
	}
	tx, err := s.SQL.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return Receipt{}, false, err
	}
	defer tx.Rollback()
	// Lock order is always NPC -> wallet. Re-check receipts after waiting for locks.
	var current int64
	var state string
	var aggro, floor int
	err = tx.QueryRowContext(ctx, "SELECT version,state,aggro,price_floor FROM npc_scenes WHERE npc_id=$1 FOR UPDATE", npc).Scan(&current, &state, &aggro, &floor)
	if errors.Is(err, sql.ErrNoRows) {
		return Receipt{}, false, ErrTrade
	}
	if err != nil {
		return Receipt{}, false, err
	}
	var balance int
	err = tx.QueryRowContext(ctx, "SELECT balance FROM players WHERE id=$1 FOR UPDATE", player).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return Receipt{}, false, ErrTrade
	}
	if err != nil {
		return Receipt{}, false, err
	}
	r, err := scanReceipt(tx.QueryRowContext(ctx, "SELECT "+receiptColumns+" FROM purchases WHERE trade_id=$1", trade))
	if err == nil {
		if r.PlayerID != player || r.NPCID != npc || r.ItemID != item || r.Amount != amount {
			return Receipt{}, false, ErrTrade
		}
		return r, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Receipt{}, false, err
	}
	if current != version {
		return Receipt{}, false, ErrStale
	}
	if state == "IDLE" || state == "CALLING" || state == "AGGRO" || aggro > 75 || amount < floor {
		return Receipt{}, false, ErrTrade
	}
	var owned bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM inventory WHERE player_id=$1 AND item_id=$2)", player, item).Scan(&owned); err != nil {
		return Receipt{}, false, err
	}
	if owned {
		return Receipt{}, false, ErrOwned
	}
	if balance < amount {
		return Receipt{}, false, ErrFunds
	}
	err = tx.QueryRowContext(ctx, "UPDATE players SET balance=balance-$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND balance>=$1 RETURNING balance", amount, player).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return Receipt{}, false, ErrFunds
	}
	if err != nil {
		return Receipt{}, false, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO inventory(player_id,item_id,price_paid) VALUES($1,$2,$3)", player, item, amount); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return Receipt{}, false, ErrOwned
		}
		return Receipt{}, false, err
	}
	r = Receipt{trade, player, npc, item, amount, balance}
	if _, err = tx.ExecContext(ctx, "INSERT INTO purchases(trade_id,player_id,npc_id,item_id,amount,balance_after) VALUES($1,$2,$3,$4,$5,$6)", trade, player, npc, item, amount, balance); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return Receipt{}, false, ErrTrade
		}
		return Receipt{}, false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE npc_scenes SET current_price=$1,version=version+1,reply_json='null'::jsonb,updated_at=CURRENT_TIMESTAMP WHERE npc_id=$2", amount, npc); err != nil {
		return Receipt{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return Receipt{}, false, err
	}
	return r, false, nil
}
