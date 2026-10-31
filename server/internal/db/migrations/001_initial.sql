CREATE TABLE players (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 login TEXT NOT NULL UNIQUE CHECK(length(trim(login)) BETWEEN 3 AND 32),
 password_hash TEXT NOT NULL,
 profile TEXT NOT NULL DEFAULT 'business' CHECK(profile IN ('business','culture')),
 pos_x REAL NOT NULL DEFAULT 110 CHECK(pos_x >= 0 AND pos_x < 200),
 pos_z REAL NOT NULL DEFAULT 110 CHECK(pos_z >= 0 AND pos_z < 200),
 rotation REAL NOT NULL DEFAULT 0,
 balance INTEGER NOT NULL DEFAULT 500 CHECK(balance >= 0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE known_words (
 player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 word_id TEXT NOT NULL CHECK(length(word_id)>0),
 learned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(player_id,word_id)
);
CREATE TABLE npc_relations (
 npc_id TEXT NOT NULL CHECK(length(npc_id)>0),
 player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'IDLE' CHECK(state IN ('IDLE','CALLING','HAGGLING','FLATTERED','SUSPICIOUS','AGGRO')),
 mianzi INTEGER NOT NULL DEFAULT 50 CHECK(mianzi BETWEEN 0 AND 100),
 aggro INTEGER NOT NULL DEFAULT 0 CHECK(aggro BETWEEN 0 AND 100),
 current_price INTEGER NOT NULL CHECK(current_price >= price_floor),
 price_floor INTEGER NOT NULL CHECK(price_floor >= 0),
 history_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json) AND json_type(history_json)='array'),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(npc_id,player_id)
);
CREATE TABLE inventory (
 player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL CHECK(length(item_id)>0),
 price_paid INTEGER NOT NULL CHECK(price_paid >= 0),
 bought_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(player_id,item_id)
);
