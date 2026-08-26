-- Cross-turn process log: completed tool results stay stored per session so
-- handles (mem1, mem2, …) remain recallable via artifact_recall and usable as
-- cloud-subagent materials across turns and app restarts. Insertion order is
-- the rowid; the primary key makes re-flushes idempotent.
CREATE TABLE IF NOT EXISTS session_artifacts (
    session_id INTEGER NOT NULL,
    handle TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_key TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, handle)
);
