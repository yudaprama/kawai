-- The Chat agent (builtin.chat) was removed; Office (builtin.office) is now the
-- single, default agent. Re-point any existing sessions so they stay visible in
-- the Office agent's sidebar instead of being orphaned.
UPDATE sessions SET agent_id = 'builtin.office' WHERE agent_id = 'builtin.chat';
