CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "users" ADD COLUMN "is_professional" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "verification_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "statement" VARCHAR(2000) NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(500),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "verification_proofs" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "request_id" UUID,
    "storage_key" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_proofs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "verification_requests_status_created_at_idx" ON "verification_requests"("status", "created_at");
CREATE INDEX "verification_requests_user_id_created_at_idx" ON "verification_requests"("user_id", "created_at");
CREATE UNIQUE INDEX "verification_proofs_storage_key_key" ON "verification_proofs"("storage_key");
CREATE INDEX "verification_proofs_owner_id_request_id_idx" ON "verification_proofs"("owner_id", "request_id");
CREATE INDEX "verification_proofs_request_id_created_at_idx" ON "verification_proofs"("request_id", "created_at");

ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "verification_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
