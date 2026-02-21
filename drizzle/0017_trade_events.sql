CREATE TABLE trade_events (
  id          TEXT PRIMARY KEY,
  trade_id    TEXT NOT NULL REFERENCES trades(id),
  action      TEXT NOT NULL,
  price       TEXT,
  quantity    INTEGER,
  legs        TEXT DEFAULT '[]',
  strategy    TEXT,
  direction   TEXT,
  message_id  TEXT,
  metadata    TEXT DEFAULT '{}',
  timestamp   TEXT NOT NULL,
  created_at  TEXT
);

CREATE INDEX idx_trade_events_trade ON trade_events(trade_id);
CREATE INDEX idx_trade_events_timestamp ON trade_events(timestamp);
