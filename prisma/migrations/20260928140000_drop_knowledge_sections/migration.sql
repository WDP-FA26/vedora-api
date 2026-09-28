-- AlterEnum
BEGIN;
CREATE TYPE "KnowledgeDocumentFailureReason_new" AS ENUM ('UPLOAD_EXPIRED', 'INVALID_FILE', 'ENCRYPTED', 'NO_TEXT', 'EXTRACTION_FAILED', 'INDEXING_FAILED');
ALTER TABLE "knowledge_documents" ALTER COLUMN "failure_reason" TYPE "KnowledgeDocumentFailureReason_new" USING ("failure_reason"::text::"KnowledgeDocumentFailureReason_new");
ALTER TYPE "KnowledgeDocumentFailureReason" RENAME TO "KnowledgeDocumentFailureReason_old";
ALTER TYPE "KnowledgeDocumentFailureReason_new" RENAME TO "KnowledgeDocumentFailureReason";
DROP TYPE "KnowledgeDocumentFailureReason_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "knowledge_document_sections" DROP CONSTRAINT "knowledge_document_sections_document_id_fkey";

-- DropTable
DROP TABLE "knowledge_document_sections";

