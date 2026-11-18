import { defineConfig } from '@mikro-orm/postgresql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { WalletSchema } from './database/schemas/wallet.schema.js';
import { Migrator } from '@mikro-orm/migrations';
import { WalletLedgerEntrySchema } from './database/schemas/walletLedgerEntry.schema.js';
import { WagerTransactionSchema } from './database/schemas/wagerTransaction.schema.js';
import { InboxMessageSchema } from './database/schemas/inboxMessage.schema.js';
import { OutboxMessageSchema } from './database/schemas/outboxMessage.schema.js';

export default defineConfig({
  entities: [WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,],
  extensions: [Migrator],
    dbName: process.env.DB_NAME || 'wagering_db',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  
  metadataProvider: TsMorphMetadataProvider,
  
  migrations: {
    path: './src/database/migrations',
    pathTs: './src/database/migrations',
  },
});