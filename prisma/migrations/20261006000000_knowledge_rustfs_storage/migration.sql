-- Knowledge documents moved from Vercel Blob to RustFS; their indexed text
-- stays, only the key column is renamed.
ALTER TABLE "knowledge_documents" RENAME COLUMN "blob_pathname" TO "storage_key";
ALTER INDEX "knowledge_documents_blob_pathname_key" RENAME TO "knowledge_documents_storage_key_key";
