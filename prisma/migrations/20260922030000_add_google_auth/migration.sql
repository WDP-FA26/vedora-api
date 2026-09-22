ALTER TABLE "users"
ALTER COLUMN "password_hash" DROP NOT NULL,
ADD COLUMN "google_id" VARCHAR(255);

CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
