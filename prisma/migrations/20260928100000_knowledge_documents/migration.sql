-- CreateEnum
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('WAITING_UPLOAD', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeDocumentFailureReason" AS ENUM ('UPLOAD_EXPIRED', 'INVALID_FILE', 'ENCRYPTED', 'NO_TEXT', 'UNSUPPORTED_TYPE', 'EXTRACTION_FAILED');

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE VARCHAR(320);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "uploaded_by_id" UUID,
    "title" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "blob_pathname" VARCHAR(512) NOT NULL,
    "size_bytes" INTEGER,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'WAITING_UPLOAD',
    "failure_reason" "KnowledgeDocumentFailureReason",
    "section_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_document_sections" (
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "knowledge_document_sections_pkey" PRIMARY KEY ("document_id","position")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_blob_pathname_key" ON "knowledge_documents"("blob_pathname");

-- CreateIndex
CREATE INDEX "knowledge_documents_status_updated_at_idx" ON "knowledge_documents"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document_sections" ADD CONSTRAINT "knowledge_document_sections_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

