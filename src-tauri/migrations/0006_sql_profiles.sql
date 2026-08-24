-- Named SQL data sources ("profiles") for the analytics agent's snapshot
-- tools (data_tables / data_import). name is what the model references;
-- source is the local SQLite path or sqlite: URL. Stored per-user so no
-- .env editing is required and isolation stays structural.
CREATE TABLE IF NOT EXISTS sql_profiles (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
