-- Profile images moved from Vercel Blob to RustFS. Their URLs pointed at
-- Vercel Blob, so users upload them again.
UPDATE "users"
SET "avatar_url" = NULL, "cover_url" = NULL
WHERE "avatar_url" IS NOT NULL OR "cover_url" IS NOT NULL;
DELETE FROM "profile_image_uploads";

-- Keys, URLs and content types are derived from "storage_key".
ALTER TABLE "users" DROP COLUMN "avatar_pathname", DROP COLUMN "cover_pathname";
ALTER TABLE "profile_image_uploads" DROP COLUMN "content_type", DROP COLUMN "url";
ALTER TABLE "profile_image_uploads" RENAME COLUMN "pathname" TO "storage_key";
ALTER INDEX "profile_image_uploads_pathname_key" RENAME TO "profile_image_uploads_storage_key_key";
