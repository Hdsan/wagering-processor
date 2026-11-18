import { EntitySchema } from '@mikro-orm/core';
import { WalletLedgerEntry } from '../../entities/walletLedgerEntry.entity.js';
import { MoneyType } from '../../common/types/MoneyType.js';

export const WalletLedgerEntrySchema = new EntitySchema<any>({
  class: WalletLedgerEntry as any,
  tableName: 'wallet_ledger_entries',
  uniques: [{ properties: ['transactionId'] }],
  indexes: [{ properties: ['walletId', 'createdAt', 'id'] }],
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    type: { type: 'string', length: 16 },
    amount: { type: MoneyType, columnType: 'numeric(19, 2)' },
    balanceBefore: { type: MoneyType, columnType: 'numeric(19, 2)' },
    balanceAfter: { type: MoneyType, columnType: 'numeric(19, 2)' },
    createdAt: { type: 'Date' },
  },
});