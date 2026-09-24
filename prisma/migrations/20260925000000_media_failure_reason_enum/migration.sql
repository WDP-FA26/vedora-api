CREATE TYPE "MediaFailureReason" AS ENUM ('TOO_LONG', 'ENCODING_FAILED', 'UPLOAD_ERRORED', 'UPLOAD_CANCELLED', 'UPLOAD_TIMED_OUT', 'NO_PLAYBACK_ID');

ALTER TABLE "media_assets"
  ALTER COLUMN "failure_reason" TYPE "MediaFailureReason"
  USING "failure_reason"::"MediaFailureReason";
