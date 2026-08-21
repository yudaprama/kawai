CREATE TABLE IF NOT EXISTS session_files (
    session_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_id)
);

CREATE TABLE IF NOT EXISTS rag_files (
    file_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    chunks INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL
);
