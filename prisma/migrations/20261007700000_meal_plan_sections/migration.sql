-- A day is now four sections (three meals and "other"), each an ordered list of dishes.
CREATE TYPE "MealSection" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'OTHER');

ALTER TABLE "meal_plan_entries"
  ADD COLUMN "section" "MealSection",
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "meal_plan_entries"
SET "section" = CASE "slot"::text
  WHEN 'BREAKFAST' THEN 'BREAKFAST'
  WHEN 'LUNCH' THEN 'LUNCH'
  WHEN 'DINNER' THEN 'DINNER'
  ELSE 'OTHER'
END::"MealSection";

-- the same dish in two snack slots of one day stays once
DELETE FROM "meal_plan_entries" a
USING "meal_plan_entries" b
WHERE a."user_id" = b."user_id"
  AND a."day" = b."day"
  AND a."section" = b."section"
  AND a."recipe_id" = b."recipe_id"
  AND a."slot" > b."slot";

UPDATE "meal_plan_entries" e
SET "position" = ranked.position
FROM (
  SELECT "user_id", "day", "slot",
         ROW_NUMBER() OVER (PARTITION BY "user_id", "day", "section" ORDER BY "slot") - 1 AS position
  FROM "meal_plan_entries"
) ranked
WHERE e."user_id" = ranked."user_id" AND e."day" = ranked."day" AND e."slot" = ranked."slot";

ALTER TABLE "meal_plan_entries" ALTER COLUMN "section" SET NOT NULL;
ALTER TABLE "meal_plan_entries" ALTER COLUMN "position" DROP DEFAULT;
ALTER TABLE "meal_plan_entries" DROP CONSTRAINT "meal_plan_entries_pkey";
ALTER TABLE "meal_plan_entries" DROP COLUMN "slot";
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_pkey" PRIMARY KEY ("user_id", "day", "section", "recipe_id");

DROP TYPE "MealSlot";
