-- Replace flat trade columns on message_labels with a single signals JSON column.
-- Backfills existing flat-field labels into Signal[] format.

CREATE TABLE IF NOT EXISTS message_labels_new (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  signals TEXT DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  reviewed INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Backfill: convert flat fields → signals JSON array
INSERT INTO message_labels_new (id, message_id, signals, source, reviewed, notes, created_at, updated_at)
SELECT
  id, message_id,
  CASE
    WHEN action IS NOT NULL AND symbol IS NOT NULL THEN
      json_array(json_object(
        'action', action,
        'symbol', symbol,
        'direction', direction,
        'strategy', strategy,
        'limitPrice', CAST(price AS REAL),
        'exitPercent', exit_percent
      ))
    ELSE '[]'
  END,
  source, reviewed, notes, created_at, updated_at
FROM message_labels;

DROP TABLE message_labels;
ALTER TABLE message_labels_new RENAME TO message_labels;

CREATE UNIQUE INDEX idx_labels_message_unique ON message_labels(message_id);
CREATE INDEX idx_labels_reviewed ON message_labels(reviewed);
