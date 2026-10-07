CREATE TYPE "PostReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'MISINFORMATION', 'HARMFUL_ADVICE', 'INAPPROPRIATE', 'OTHER');
CREATE TYPE "PostReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

ALTER TABLE "posts" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "post_reposts" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_reposts_pkey" PRIMARY KEY ("post_id", "user_id")
);

CREATE TABLE "post_reports" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" "PostReportReason" NOT NULL,
    "details" VARCHAR(500),
    "status" "PostReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "post_reposts_user_id_created_at_idx" ON "post_reposts"("user_id", "created_at");
CREATE UNIQUE INDEX "post_reports_post_id_reporter_id_key" ON "post_reports"("post_id", "reporter_id");
CREATE INDEX "post_reports_status_created_at_idx" ON "post_reports"("status", "created_at");

ALTER TABLE "post_reposts" ADD CONSTRAINT "post_reposts_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_reposts" ADD CONSTRAINT "post_reposts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_reports" ADD CONSTRAINT "post_reports_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_reports" ADD CONSTRAINT "post_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_reports" ADD CONSTRAINT "post_reports_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
