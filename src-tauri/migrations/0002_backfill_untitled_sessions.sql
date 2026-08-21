-- Legacy sessions created before first-message title-seeding always have an
-- empty title and can never be re-titled by the normal path. Give them a stable
-- placeholder so the sidebar never renders a blank row.
UPDATE sessions SET title = '(untitled)' WHERE title = '';
