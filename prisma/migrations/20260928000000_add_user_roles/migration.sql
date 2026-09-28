-- All existing accounts start with ordinary user permissions. The explicit
-- admin seed grants ADMIN to the trusted bootstrap account.
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
