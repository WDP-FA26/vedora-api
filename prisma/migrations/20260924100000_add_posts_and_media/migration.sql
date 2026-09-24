-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('POST', 'BLOG');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('VIDEO', 'IMAGE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('WAITING_UPLOAD', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "type" "PostType" NOT NULL DEFAULT 'POST',
    "status" "PostStatus" NOT NULL DEFAULT 'PROCESSING',
    "body" VARCHAR(280),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "type" "MediaType" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'WAITING_UPLOAD',
    "failure_reason" VARCHAR(64),
    "post_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "mux_upload_id" VARCHAR(255),
    "mux_asset_id" VARCHAR(255),
    "playback_id" VARCHAR(255),
    "duration_sec" DOUBLE PRECISION,
    "aspect_ratio" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posts_status_published_at_idx" ON "posts"("status", "published_at");

-- CreateIndex
CREATE INDEX "posts_author_id_created_at_idx" ON "posts"("author_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_mux_upload_id_key" ON "media_assets"("mux_upload_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_mux_asset_id_key" ON "media_assets"("mux_asset_id");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_status_idx" ON "media_assets"("owner_id", "status");

-- CreateIndex
CREATE INDEX "media_assets_post_id_idx" ON "media_assets"("post_id");

-- CreateIndex
CREATE INDEX "media_assets_status_updated_at_idx" ON "media_assets"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

