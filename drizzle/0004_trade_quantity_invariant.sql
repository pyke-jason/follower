UPDATE "trades"
SET "quantity" = 1
WHERE "quantity" IS NULL;

ALTER TABLE "trades" ALTER COLUMN "quantity" SET DEFAULT 1;
ALTER TABLE "trades" ALTER COLUMN "quantity" SET NOT NULL;
