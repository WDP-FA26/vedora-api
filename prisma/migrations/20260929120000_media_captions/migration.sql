-- CreateEnum
CREATE TYPE "CaptionStatus" AS ENUM ('NONE', 'GENERATING', 'ATTACHING', 'TRANSLATING', 'READY', 'NO_SPEECH', 'FAILED');

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "caption_job_id" VARCHAR(255),
ADD COLUMN     "caption_language" VARCHAR(16),
ADD COLUMN     "caption_status" "CaptionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "caption_track_id" VARCHAR(255);

-- CreateIndex
CREATE INDEX "media_assets_caption_status_updated_at_idx" ON "media_assets"("caption_status", "updated_at");

-- CreateIndex
CREATE INDEX "media_assets_caption_job_id_idx" ON "media_assets"("caption_job_id");

-- CreateIndex
CREATE INDEX "media_assets_caption_track_id_idx" ON "media_assets"("caption_track_id");

