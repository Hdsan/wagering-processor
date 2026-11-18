import { Migration } from '@mikro-orm/migrations';

export class Migration20261118011317 extends Migration {

  override name = 'Migration20261118011317';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(64) not null, "message_id" varchar(128) not null, "payload_hash" varchar(64) not null, "status" varchar(16) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_message_id_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_type" varchar(64) not null, "aggregate_id" varchar(128) not null, "event_type" varchar(64) not null, "payload" jsonb not null, "status" varchar(16) not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "created_at" timestamptz not null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_status_next_attempt_at_index" on "outbox_messages" ("status", "next_attempt_at");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid null, "player_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "kind" varchar(20) not null, "amount" numeric(19, 2) not null, "currency" varchar(3) not null, "status" varchar(30) not null, "provider" varchar(100) not null, "external_transaction_id" varchar(255) null, "round_id" varchar(255) null, "game_id" varchar(255) null, "reference_transaction_id" varchar(255) null, "reference_id" varchar(255) null, "payload_hash" varchar(64) not null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`);
    this.addSql(`create unique index "wager_transactions_provider_external_unique" on "wager_transactions" ("provider", "external_transaction_id") where "external_transaction_id" is not null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_positive" check (amount > 0 or kind = 'LOSS');`);
    this.addSql(`create index "wager_transactions_status_created_at_index" on "wager_transactions" ("status", "created_at");`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(128) not null, "currency" varchar(3) not null, "balance" numeric(19, 2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "type" varchar(16) not null, "amount" numeric(19, 2) not null, "balance_before" numeric(19, 2) not null, "balance_after" numeric(19, 2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_unique" unique ("transaction_id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balances_non_negative" check (balance_before >= 0 and balance_after >= 0);`);
    this.addSql(`create index "wallet_ledger_entries_wallet_id_created_at_id_index" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql('alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);'); 
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table "wager_transactions" cascade;`);
    this.addSql(`drop table "outbox_messages" cascade;`);
    this.addSql(`drop table "inbox_messages" cascade;`);
    this.addSql(`drop table "wallets" cascade;`);
  }

}
