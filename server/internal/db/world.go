package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
)

var ErrWorldConflict = errors.New("world version conflict")
var ErrWorldUninitialized = errors.New("world is not initialized")

type WorldChunk struct {
	Data     json.RawMessage `json:"data"`
	Revision int64           `json:"revision"`
}

// LoadWorld seeds an empty world exactly once; the lock also serializes concurrent startups.
func (s *Store) LoadWorld(ctx context.Context, seed map[string]json.RawMessage) (map[string]WorldChunk, error) {
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(824009202)"); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM world_chunks").Scan(&count); err != nil {
		return nil, err
	}
	if count == 0 {
		if len(seed) == 0 {
			return nil, ErrWorldUninitialized
		}
		for id, data := range seed {
			if _, err = tx.ExecContext(ctx, "INSERT INTO world_chunks(chunk_id,data) VALUES($1,$2::jsonb)", id, string(data)); err != nil {
				return nil, err
			}
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT chunk_id,data,revision FROM world_chunks")
	if err != nil {
		return nil, err
	}
	out := make(map[string]WorldChunk)
	for rows.Next() {
		var id string
		var chunk WorldChunk
		if err = rows.Scan(&id, &chunk.Data, &chunk.Revision); err != nil {
			rows.Close()
			return nil, err
		}
		out[id] = chunk
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(out) != 100 || (len(seed) > 0 && len(out) != len(seed)) {
		return nil, errors.New("incomplete stored world")
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}
func (s *Store) SaveWorld(ctx context.Context, updates map[string]WorldChunk) error {
	tx, err := s.SQL.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ids := make([]string, 0, len(updates))
	for id := range updates {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		u := updates[id]
		result, err := tx.ExecContext(ctx, "UPDATE world_chunks SET data=$1::jsonb, revision=revision+1 WHERE chunk_id=$2 AND revision=$3", string(u.Data), id, u.Revision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrWorldConflict
		}
	}
	return tx.Commit()
}
