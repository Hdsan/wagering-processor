import { EntitySchema } from '@mikro-orm/core';
import { Wallet } from '../../entities/wallet.entity.js';
import { MoneyType } from '../../common/types/MoneyType.js';

export const WalletSchema = new EntitySchema<Wallet>({
  class: Wallet as any,
  tableName: 'wallets',
  uniques: [{ properties: ['playerId', 'currency'] }],
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', length: 128 },
    currency: { type: 'string', length: 3 },
    _balance: { type: MoneyType, columnType: 'numeric(19, 2)', fieldName: 'balance' },
    _version: { type: 'number', fieldName: 'version', default: 1 },
    createdAt: { type: 'Date' },
    _updatedAt: { type: 'Date', fieldName: 'updated_at' },
  } as any,
});