-- AlterEnum
ALTER TYPE "KnowledgeDocumentFailureReason" ADD VALUE 'INDEXING_FAILED';

-- AlterTable
ALTER TABLE "knowledge_documents" ADD COLUMN     "image_count" INTEGER;
