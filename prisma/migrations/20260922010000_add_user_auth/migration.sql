ALTER TABLE "users"
ADD COLUMN "username" VARCHAR(30),
ADD COLUMN "password_hash" VARCHAR(60),
ADD COLUMN "full_name" VARCHAR(100);

-- Preserve pre-auth users. They must reset/register a password before they can log in.
UPDATE "users"
SET
  "username" = 'user_' || LEFT(REPLACE("id"::text, '-', ''), 24),
  "password_hash" = '!migrated-user-has-no-password',
  "full_name" = LEFT(COALESCE(NULLIF(TRIM("name"), ''), "email"), 100);

ALTER TABLE "users"
ALTER COLUMN "username" SET NOT NULL,
ALTER COLUMN "password_hash" SET NOT NULL,
ALTER COLUMN "full_name" SET NOT NULL;

ALTER TABLE "users" DROP COLUMN "name";

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
