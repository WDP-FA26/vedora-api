-- CreateEnum
CREATE TYPE "FollowSuggestionReason" AS ENUM ('FOLLOWS_YOU', 'MUTUAL');

-- CreateTable
CREATE TABLE "follow_suggestions" (
    "user_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "reason" "FollowSuggestionReason" NOT NULL,
    "mutual_count" INTEGER NOT NULL,

    CONSTRAINT "follow_suggestions_pkey" PRIMARY KEY ("user_id","candidate_id")
);

-- CreateTable
CREATE TABLE "suggestion_dismissals" (
    "user_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestion_dismissals_pkey" PRIMARY KEY ("user_id","candidate_id")
);

-- CreateIndex
CREATE INDEX "follow_suggestions_user_id_score_candidate_id_idx" ON "follow_suggestions"("user_id", "score" DESC, "candidate_id");

-- CreateIndex
CREATE INDEX "follow_suggestions_candidate_id_idx" ON "follow_suggestions"("candidate_id");

-- AddForeignKey
ALTER TABLE "follow_suggestions" ADD CONSTRAINT "follow_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_suggestions" ADD CONSTRAINT "follow_suggestions_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_dismissals" ADD CONSTRAINT "suggestion_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
