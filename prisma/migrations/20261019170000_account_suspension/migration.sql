CREATE TYPE "AccountStatus" AS ENUM ('PENDING_EMAIL', 'ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE "UserAccountAction" AS ENUM ('SUSPEND', 'REACTIVATE', 'ROLE_CHANGE', 'DELETE');

ALTER TABLE "users"
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_EMAIL',
  ADD COLUMN "account_version" INTEGER NOT NULL DEFAULT 0;

UPDATE "users" SET "status" = 'ACTIVE' WHERE "email_verified_at" IS NOT NULL;

CREATE TABLE "user_account_audits" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "action" "UserAccountAction" NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "previous_status" "AccountStatus" NOT NULL,
  "status" "AccountStatus" NOT NULL,
  "previous_role" "UserRole" NOT NULL,
  "role" "UserRole" NOT NULL,
  "account_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_account_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_account_audits_user_id_created_at_idx" ON "user_account_audits"("user_id", "created_at");
CREATE INDEX "user_account_audits_actor_id_created_at_idx" ON "user_account_audits"("actor_id", "created_at");
