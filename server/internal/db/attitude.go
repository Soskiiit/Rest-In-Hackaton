package db

import "context"

// Offset is the admin's personal correction of an NPC's mood towards one player.
// What the NPC shows that player is the shared scene mood plus this offset, clamped to 0..100.
type Offset struct {
	Mianzi int `json:"mianzi_offset"`
	Aggro  int `json:"aggro_offset"`
}

// Attitude is one row of the admin view: a registered player and the NPC's offset towards them.
type Attitude struct {
	PlayerID int64
	Login    string
	Offset
}

// Offsets returns the player's non-zero offsets by NPC id.
func (s *Store) Offsets(ctx context.Context, playerID int64) (map[string]Offset, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT npc_id,mianzi_offset,aggro_offset FROM npc_relations WHERE player_id=$1 AND (mianzi_offset<>0 OR aggro_offset<>0)", playerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Offset{}
	for rows.Next() {
		var npc string
		var o Offset
		if err = rows.Scan(&npc, &o.Mianzi, &o.Aggro); err != nil {
			return nil, err
		}
		out[npc] = o
	}
	return out, rows.Err()
}

// NPCAttitudes lists every registered player with the NPC's offset towards them, by login.
func (s *Store) NPCAttitudes(ctx context.Context, npc string) ([]Attitude, error) {
	rows, err := s.SQL.QueryContext(ctx, "SELECT p.id,p.login,COALESCE(r.mianzi_offset,0),COALESCE(r.aggro_offset,0) FROM players p LEFT JOIN npc_relations r ON r.player_id=p.id AND r.npc_id=$1 ORDER BY p.login", npc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attitude{}
	for rows.Next() {
		var a Attitude
		if err = rows.Scan(&a.PlayerID, &a.Login, &a.Mianzi, &a.Aggro); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SetOffset stores the offset, creating the relation row if the player never talked to the NPC.
// The relation's history and mood snapshot are left untouched.
func (s *Store) SetOffset(ctx context.Context, playerID int64, npc string, o Offset, price, floor int) error {
	_, err := s.SQL.ExecContext(ctx, "INSERT INTO npc_relations(npc_id,player_id,current_price,price_floor,mianzi_offset,aggro_offset) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(npc_id,player_id) DO UPDATE SET mianzi_offset=EXCLUDED.mianzi_offset,aggro_offset=EXCLUDED.aggro_offset,updated_at=CURRENT_TIMESTAMP", npc, playerID, price, floor, o.Mianzi, o.Aggro)
	return err
}
