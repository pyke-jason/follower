-- Near-duplicate message dedup: content hash column + index on messages table.
-- Column and index were applied outside migration system; this is a no-op catch-up.
CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(author, content_hash);
