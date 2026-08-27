-- L1 memories: atomic long-term memory items distilled from conversations
-- (Tencent L1 taxonomy: preference / rule / event / fact / goal). Per-user DB
-- (no user_id column — structural isolation). `source_session_id` records
-- which session an item was extracted from; NULL = manually created.
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'fact',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_session_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_session_id);
