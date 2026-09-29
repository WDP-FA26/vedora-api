-- AlterTable
ALTER TABLE "users" ADD COLUMN "bio" VARCHAR(500),
ADD COLUMN "avatar_url" VARCHAR(2048),
ADD COLUMN "avatar_pathname" VARCHAR(512),
ADD COLUMN "cover_url" VARCHAR(2048),
ADD COLUMN "cover_pathname" VARCHAR(512);

-- CreateEnum
CREATE TYPE "ProfileImageKind" AS ENUM ('AVATAR', 'COVER');
CREATE TYPE "ProfileImageStatus" AS ENUM ('WAITING_UPLOAD', 'READY');

-- CreateTable
CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "following_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id","following_id"),
    CONSTRAINT "follows_no_self_follow" CHECK ("follower_id" <> "following_id")
);

CREATE TABLE "profile_image_uploads" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "kind" "ProfileImageKind" NOT NULL,
    "status" "ProfileImageStatus" NOT NULL DEFAULT 'WAITING_UPLOAD',
    "content_type" VARCHAR(32) NOT NULL,
    "pathname" VARCHAR(512) NOT NULL,
    "url" VARCHAR(2048),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "profile_image_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follows_following_id_created_at_follower_id_idx" ON "follows"("following_id", "created_at", "follower_id");
CREATE INDEX "follows_follower_id_created_at_following_id_idx" ON "follows"("follower_id", "created_at", "following_id");
CREATE UNIQUE INDEX "profile_image_uploads_pathname_key" ON "profile_image_uploads"("pathname");
CREATE INDEX "profile_image_uploads_owner_id_status_idx" ON "profile_image_uploads"("owner_id", "status");
CREATE INDEX "profile_image_uploads_status_created_at_idx" ON "profile_image_uploads"("status", "created_at");

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "profile_image_uploads" ADD CONSTRAINT "profile_image_uploads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
