CREATE TABLE world_chunks (
 chunk_id TEXT PRIMARY KEY,
 data JSONB NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)
);
