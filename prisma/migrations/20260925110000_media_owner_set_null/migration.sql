-- Keep media rows when their owner is deleted, so the purge cron can still
-- delete the videos from Mux before dropping the rows.

-- DropForeignKey
ALTER TABLE "media_assets" DROP CONSTRAINT "media_assets_owner_id_fkey";

-- AlterTable
ALTER TABLE "media_assets" ALTER COLUMN "owner_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
