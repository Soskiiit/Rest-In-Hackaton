CREATE TABLE npc_scenes (
 npc_id TEXT PRIMARY KEY NOT NULL CHECK(length(npc_id)>0),
 state TEXT NOT NULL DEFAULT 'IDLE' CHECK(state IN ('IDLE','CALLING','HAGGLING','FLATTERED','SUSPICIOUS','AGGRO')),
 mianzi INTEGER NOT NULL DEFAULT 50 CHECK(mianzi BETWEEN 0 AND 100),
 aggro INTEGER NOT NULL DEFAULT 0 CHECK(aggro BETWEEN 0 AND 100),
 current_price INTEGER NOT NULL CHECK(current_price>=price_floor),
 price_floor INTEGER NOT NULL CHECK(price_floor>=0),
 history_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json) AND json_type(history_json)='array'),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 reply_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(reply_json)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE purchases (
 trade_id TEXT PRIMARY KEY NOT NULL,
 player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 npc_id TEXT NOT NULL REFERENCES npc_scenes(npc_id),
 item_id TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0),
 balance_after INTEGER NOT NULL CHECK(balance_after>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(player_id,item_id)
);
CREATE INDEX purchases_player ON purchases(player_id);
CREATE INDEX npc_relations_player ON npc_relations(player_id);
