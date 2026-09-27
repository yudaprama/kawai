-- Shared squawk DB schema (market squawk cache + history).
-- Single source of truth — applied by init-schema.sh over HTTP (Hrana /v2/pipeline),
-- so the SAME script provisions a local sqld and a remote VPS sqld identically.
--
-- Tables:
-- - squawk_cache      — single-row snapshot per source (key), refreshed replace-all
-- - squawk_items      — searchable history, dedup by feed item id (PK)
-- - squawk_items_fts  — FTS5 (BM25) mirror kept in sync by triggers below

CREATE TABLE IF NOT EXISTS squawk_cache (
  key           TEXT PRIMARY KEY,
  payload_json  TEXT NOT NULL,
  item_count    INTEGER NOT NULL,
  fetched_at    INTEGER NOT NULL,
  fetched_at_rfc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS squawk_items (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  url          TEXT NOT NULL,
  source       TEXT NOT NULL,
  published_at INTEGER,
  fetched_at   INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS squawk_items_fts USING fts5(
  id UNINDEXED, title, summary, source
);

CREATE TRIGGER IF NOT EXISTS squawk_items_ai AFTER INSERT ON squawk_items BEGIN
  INSERT INTO squawk_items_fts (id, title, summary, source)
  VALUES (new.id, new.title, new.summary, new.source);
END;

CREATE TRIGGER IF NOT EXISTS squawk_items_ad AFTER DELETE ON squawk_items BEGIN
  DELETE FROM squawk_items_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS squawk_items_au AFTER UPDATE ON squawk_items BEGIN
  DELETE FROM squawk_items_fts WHERE id = old.id;
  INSERT INTO squawk_items_fts (id, title, summary, source)
  VALUES (new.id, new.title, new.summary, new.source);
END;
