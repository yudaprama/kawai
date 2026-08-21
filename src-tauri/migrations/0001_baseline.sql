CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id);

CREATE TABLE IF NOT EXISTS turn_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    tool TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
