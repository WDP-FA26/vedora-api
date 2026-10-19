-- Videos move from Mux to Cloudinary. Mux-hosted media can't be carried over,
-- so it is deleted; its assets have to be removed in the Mux dashboard.
DELETE FROM "media_assets";

-- Posts that were only a Mux video are now empty: drop them. Posts waiting
-- on a deleted video publish with their text; failed ones stay hidden.
DELETE FROM "posts"
WHERE "type" = 'POST'
  AND "body" IS NULL
  AND "status" IN ('PROCESSING', 'PUBLISHED', 'FAILED');
UPDATE "posts"
SET "status" = 'PUBLISHED', "published_at" = COALESCE("published_at", CURRENT_TIMESTAMP)
WHERE "type" = 'POST' AND "status" = 'PROCESSING';

-- AlterEnum
BEGIN;
CREATE TYPE "MediaFailureReason_new" AS ENUM ('TOO_LONG', 'ENCODING_FAILED', 'UPLOAD_ERRORED', 'UPLOAD_TIMED_OUT');
ALTER TABLE "media_assets" ALTER COLUMN "failure_reason" TYPE "MediaFailureReason_new" USING ("failure_reason"::text::"MediaFailureReason_new");
ALTER TYPE "MediaFailureReason" RENAME TO "MediaFailureReason_old";
ALTER TYPE "MediaFailureReason_new" RENAME TO "MediaFailureReason";
DROP TYPE "MediaFailureReason_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CaptionStatus_new" AS ENUM ('NONE', 'TRANSCRIBING', 'READY', 'NO_SPEECH', 'FAILED');
ALTER TABLE "media_assets" ALTER COLUMN "caption_status" DROP DEFAULT;
ALTER TABLE "media_assets" ALTER COLUMN "caption_status" TYPE "CaptionStatus_new" USING ("caption_status"::text::"CaptionStatus_new");
ALTER TYPE "CaptionStatus" RENAME TO "CaptionStatus_old";
ALTER TYPE "CaptionStatus_new" RENAME TO "CaptionStatus";
DROP TYPE "CaptionStatus_old";
ALTER TABLE "media_assets" ALTER COLUMN "caption_status" SET DEFAULT 'NONE';
COMMIT;

-- DropIndex
DROP INDEX "media_assets_mux_upload_id_key";

-- DropIndex
DROP INDEX "media_assets_mux_asset_id_key";

-- DropIndex
DROP INDEX "media_assets_caption_job_id_idx";

-- DropIndex
DROP INDEX "media_assets_caption_track_id_idx";

-- AlterTable
ALTER TABLE "media_assets" DROP COLUMN "caption_job_id",
DROP COLUMN "caption_track_id",
DROP COLUMN "mux_asset_id",
DROP COLUMN "mux_upload_id",
DROP COLUMN "playback_id",
ADD COLUMN     "public_id" VARCHAR(255) NOT NULL;

-- CreateTable
CREATE TABLE "media_captions" (
    "id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "language_code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "is_original" BOOLEAN NOT NULL,
    "url" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_captions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_captions_media_id_language_code_key" ON "media_captions"("media_id", "language_code");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_public_id_key" ON "media_assets"("public_id");

-- AddForeignKey
ALTER TABLE "media_captions" ADD CONSTRAINT "media_captions_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

