-- Skills: reusable instruction sets (SKILL.md format) the user curates for
-- their agents. Per-user DB (no user_id column — structural isolation).
-- Version is a monotonic counter bumped on every update; history is not
-- retained in this tier.
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
