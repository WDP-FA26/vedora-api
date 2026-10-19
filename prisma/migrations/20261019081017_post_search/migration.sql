-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "search_indexed_at" TIMESTAMP(3),
ALTER COLUMN "body" SET DATA TYPE VARCHAR(2000);
