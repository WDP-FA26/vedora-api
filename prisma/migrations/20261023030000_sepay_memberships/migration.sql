-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('PRO', 'PREMIUM');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_code" "BillingPlan" NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "amount" DECIMAL(19,0) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "invoice_number" VARCHAR(80) NOT NULL,
    "payment_code" VARCHAR(50) NOT NULL,
    "active_intent_key" UUID,
    "bank_code" VARCHAR(50) NOT NULL,
    "bank_gateway" VARCHAR(100) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "account_holder" VARCHAR(150) NOT NULL,
    "store_name" VARCHAR(100) NOT NULL,
    "transfer_content" VARCHAR(100) NOT NULL,
    "provider_transaction_id" VARCHAR(100),
    "provider_reference" VARCHAR(255),
    "paid_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "request_key" VARCHAR(200) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "intent_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "user_id" UUID NOT NULL,
    "plan_code" "BillingPlan" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "payment_id" UUID NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "payment_ledger" (
    "id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_transaction_id" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(19,0) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "plan_code" "BillingPlan" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_audits" (
    "id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_receipts" (
    "id" UUID NOT NULL,
    "provider_transaction_id" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "outcome" VARCHAR(50) NOT NULL,
    "intent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_invoice_number_key" ON "payment_intents"("invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_payment_code_key" ON "payment_intents"("payment_code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_active_intent_key_key" ON "payment_intents"("active_intent_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_transaction_id_key" ON "payment_intents"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_intents_user_id_created_at_idx" ON "payment_intents"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_actor_id_request_key_key" ON "payment_requests"("actor_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_payment_id_key" ON "memberships"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_ledger_intent_id_key" ON "payment_ledger"("intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_ledger_provider_transaction_id_key" ON "payment_ledger"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_ledger_user_id_created_at_idx" ON "payment_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_audits_intent_id_created_at_idx" ON "payment_audits"("intent_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_webhook_receipts_provider_transaction_id_created_at_idx" ON "payment_webhook_receipts"("provider_transaction_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_webhook_receipts_intent_id_created_at_idx" ON "payment_webhook_receipts"("intent_id", "created_at");

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_ledger" ADD CONSTRAINT "payment_ledger_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_audits" ADD CONSTRAINT "payment_audits_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_receipts" ADD CONSTRAINT "payment_webhook_receipts_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Financial invariants are also enforced below the application layer.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_money_check"
  CHECK (amount > 0 AND amount <= 1000000000 AND currency = 'VND' AND duration_days BETWEEN 1 AND 365);
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_active_check"
  CHECK ((status = 'PENDING' AND active_intent_key IS NOT NULL AND active_intent_key = user_id) OR (status <> 'PENDING' AND active_intent_key IS NULL));
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_capture_check"
  CHECK (status <> 'SUCCEEDED' OR (provider_transaction_id IS NOT NULL AND paid_at IS NOT NULL AND captured_at IS NOT NULL));
ALTER TABLE "payment_ledger" ADD CONSTRAINT "payment_ledger_money_check"
  CHECK (amount > 0 AND currency = 'VND' AND expires_at > starts_at);
