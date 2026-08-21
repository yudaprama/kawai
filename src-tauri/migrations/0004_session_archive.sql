-- Archive support for the sessions sidebar: archived sessions stay queryable
-- (and re-listable via list_chat_sessions { archived: true }) but drop out of
-- the active sidebar list. archived_at records when the row was archived.
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
