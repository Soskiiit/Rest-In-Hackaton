package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	_, err := s.SQL.ExecContext(ctx, "INSERT INTO npc_scenes(npc_id,current_price,price_floor) VALUES(?,?,?) ON CONFLICT(npc_id) DO NOTHING", npc, price, floor)
	if err != nil {
		return Scene{}, err
	}
	out := Scene{Relation: Relation{NPCID: npc}}
	var history, reply string
	err = s.SQL.QueryRowContext(ctx, "SELECT state,mianzi,aggro,current_price,price_floor,history_json,version,reply_json FROM npc_scenes WHERE npc_id=?", npc).Scan(&out.State, &out.Mianzi, &out.Aggro, &out.Price, &out.Floor, &history, &out.Version, &reply)
	if err != nil {
		return out, err
	}
	out.Reply = json.RawMessage(reply)
	err = json.Unmarshal([]byte(history), &out.History)
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
	res, err := tx.ExecContext(ctx, "UPDATE npc_scenes SET state=?,mianzi=?,aggro=?,current_price=?,history_json=?,reply_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE npc_id=? AND version=?", scene.State, scene.Mianzi, scene.Aggro, scene.Price, string(history), string(reply), scene.NPCID, scene.Version)
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
	_, err = tx.ExecContext(ctx, "INSERT INTO npc_relations(npc_id,player_id,state,mianzi,aggro,current_price,price_floor,history_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(npc_id,player_id) DO UPDATE SET state=excluded.state,mianzi=excluded.mianzi,aggro=excluded.aggro,current_price=excluded.current_price,price_floor=excluded.price_floor,history_json=excluded.history_json,updated_at=CURRENT_TIMESTAMP", personal.NPCID, personal.PlayerID, personal.State, personal.Mianzi, personal.Aggro, personal.Price, personal.Floor, string(history))
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return scene.Version + 1, nil
}
func (s *Store) Receipt(ctx context.Context, player int64, id string) (Receipt, error) {
	var r Receipt
	err := s.SQL.QueryRowContext(ctx, "SELECT trade_id,player_id,npc_id,item_id,amount,balance_after FROM purchases WHERE player_id=? AND trade_id=?", player, id).Scan(&r.TradeID, &r.PlayerID, &r.NPCID, &r.ItemID, &r.Amount, &r.BalanceAfter)
	return r, err
}
func (s *Store) Buy(ctx context.Context, player int64, trade, npc, item string, amount int, version int64) (Receipt, bool, error) {
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return Receipt{}, false, err
	}
	defer tx.Rollback()
	var r Receipt
	err = tx.QueryRowContext(ctx, "SELECT trade_id,player_id,npc_id,item_id,amount,balance_after FROM purchases WHERE trade_id=?", trade).Scan(&r.TradeID, &r.PlayerID, &r.NPCID, &r.ItemID, &r.Amount, &r.BalanceAfter)
	if err == nil {
		if r.PlayerID != player || r.NPCID != npc || r.ItemID != item || r.Amount != amount {
			return Receipt{}, false, ErrTrade
		}
		return r, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Receipt{}, false, err
	}
	if amount < 1 || amount > 100000 || trade == "" {
		return Receipt{}, false, ErrTrade
	}
	var current int64
	var state string
	var aggro, floor int
	err = tx.QueryRowContext(ctx, "SELECT version,state,aggro,price_floor FROM npc_scenes WHERE npc_id=?", npc).Scan(&current, &state, &aggro, &floor)
	if err != nil {
		return Receipt{}, false, err
	}
	if current != version {
		return Receipt{}, false, ErrStale
	}
	if state == "IDLE" || state == "CALLING" || state == "AGGRO" || aggro > 75 || amount < floor {
		return Receipt{}, false, ErrTrade
	}
	var owned int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM inventory WHERE player_id=? AND item_id=?", player, item).Scan(&owned); err != nil {
		return Receipt{}, false, err
	}
	if owned != 0 {
		return Receipt{}, false, ErrOwned
	}
	res, err := tx.ExecContext(ctx, "UPDATE players SET balance=balance-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND balance>=?", amount, player, amount)
	if err != nil {
		return Receipt{}, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Receipt{}, false, err
	}
	if n != 1 {
		return Receipt{}, false, ErrFunds
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO inventory(player_id,item_id,price_paid) VALUES(?,?,?)", player, item, amount); err != nil {
		return Receipt{}, false, err
	}
	var balance int
	if err = tx.QueryRowContext(ctx, "SELECT balance FROM players WHERE id=?", player).Scan(&balance); err != nil {
		return Receipt{}, false, err
	}
	r = Receipt{trade, player, npc, item, amount, balance}
	if _, err = tx.ExecContext(ctx, "INSERT INTO purchases(trade_id,player_id,npc_id,item_id,amount,balance_after) VALUES(?,?,?,?,?,?)", trade, player, npc, item, amount, balance); err != nil {
		return Receipt{}, false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE npc_scenes SET current_price=?,version=version+1,reply_json='null',updated_at=CURRENT_TIMESTAMP WHERE npc_id=?", amount, npc); err != nil {
		return Receipt{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return Receipt{}, false, err
	}
	return r, false, nil
}
