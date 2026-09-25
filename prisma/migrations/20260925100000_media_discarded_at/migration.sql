-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "discarded_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "media_assets_discarded_at_idx" ON "media_assets"("discarded_at");
