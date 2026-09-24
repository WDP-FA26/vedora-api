ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Accounts from before verification existed are trusted as they are. Leaving
-- them unverified would let anyone reclaim their username or email by
-- registering it (see UsersService.deleteStaleUnverified).
UPDATE "users" SET "email_verified_at" = CURRENT_TIMESTAMP;

CREATE TABLE "email_verification_codes" (
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "first_sent_at" TIMESTAMP(3) NOT NULL,
    "resend_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "email_verification_guesses" (
    "email" VARCHAR(320) NOT NULL,
    "guesses" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_verification_guesses_pkey" PRIMARY KEY ("email")
);
