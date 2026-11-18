import { Migration } from '@mikro-orm/migrations';

export class Migration20261118160000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "wager_transactions"
        ADD COLUMN IF NOT EXISTS "wallet_id" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "player_id" varchar(255) NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS "currency" varchar(10) NOT NULL DEFAULT 'BRL',
        ADD COLUMN IF NOT EXISTS "provider" varchar(100) NOT NULL DEFAULT 'default',
        ADD COLUMN IF NOT EXISTS "external_transaction_id" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "round_id" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "game_id" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "reference_transaction_id" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "payload_hash" varchar(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "failure_code" varchar(100) NULL;
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
        ALTER COLUMN "player_id" DROP DEFAULT,
        ALTER COLUMN "currency" DROP DEFAULT,
        ALTER COLUMN "provider" DROP DEFAULT,
        ALTER COLUMN "payload_hash" DROP DEFAULT;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_wager_tx_provider_ext_id"
      ON "wager_transactions" ("provider", "external_transaction_id")
      WHERE "external_transaction_id" IS NOT NULL;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_wager_tx_active_reversal"
      ON "wager_transactions" ("reference_transaction_id", "kind")
      WHERE "kind" IN ('REFUND', 'ROLLBACK') AND "status" IN ('PROCESSED', 'PENDING_REFERENCE');
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "uq_wager_tx_active_reversal";`);
    this.addSql(`DROP INDEX IF EXISTS "uq_wager_tx_provider_ext_id";`);
  }
}