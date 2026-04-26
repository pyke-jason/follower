WITH malformed_trades AS (
  SELECT id
  FROM trades
  WHERE jsonb_typeof(legs) <> 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(legs) = 'array' THEN legs ELSE '[]'::jsonb END) AS leg
      WHERE jsonb_typeof(leg) <> 'object'
        OR NOT (leg ? 'symbol')
        OR jsonb_typeof(leg -> 'symbol') <> 'string'
        OR btrim(leg ->> 'symbol') = ''
    )
)
DELETE FROM trade_events
WHERE trade_id IN (SELECT id FROM malformed_trades);
--> statement-breakpoint
WITH malformed_trades AS (
  SELECT id
  FROM trades
  WHERE jsonb_typeof(legs) <> 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(legs) = 'array' THEN legs ELSE '[]'::jsonb END) AS leg
      WHERE jsonb_typeof(leg) <> 'object'
        OR NOT (leg ? 'symbol')
        OR jsonb_typeof(leg -> 'symbol') <> 'string'
        OR btrim(leg ->> 'symbol') = ''
    )
)
DELETE FROM trades
WHERE id IN (SELECT id FROM malformed_trades);
--> statement-breakpoint
DELETE FROM trade_events
WHERE jsonb_typeof(legs) <> 'array'
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(legs) = 'array' THEN legs ELSE '[]'::jsonb END) AS leg
    WHERE jsonb_typeof(leg) <> 'object'
      OR NOT (leg ? 'symbol')
      OR jsonb_typeof(leg -> 'symbol') <> 'string'
      OR btrim(leg ->> 'symbol') = ''
  );
