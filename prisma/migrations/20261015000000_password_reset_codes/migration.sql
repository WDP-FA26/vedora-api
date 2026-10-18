-- CreateTable
CREATE TABLE "password_reset_codes" (
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "first_sent_at" TIMESTAMP(3) NOT NULL,
    "resend_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

