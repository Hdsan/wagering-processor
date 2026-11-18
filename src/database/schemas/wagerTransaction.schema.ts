import { EntitySchema } from '@mikro-orm/core';
import { WagerTransaction } from '../../entities/wagerTransaction.entity.js';
import { MoneyType } from '../../common/types/MoneyType.js';

export const WagerTransactionSchema = new EntitySchema<any>({
  class: WagerTransaction as any,
  tableName: 'wager_transactions',
  uniques: [{ properties: ['provider', 'externalTransactionId'] }],
  properties: {
    id: { type: 'string', primary: true },
    walletId: { type: 'string', nullable: true, fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    idempotencyKey: { type: 'string', unique: true, fieldName: 'idempotency_key' },
    kind: { type: 'string', length: 20 },
    amount: { type: MoneyType },
    currency: { type: 'string', length: 10 },
    _status: { type: 'string', length: 30, fieldName: 'status' },
    provider: { type: 'string', length: 100 },
    externalTransactionId: { type: 'string', nullable: true, fieldName: 'external_transaction_id' },
    roundId: { type: 'string', nullable: true, fieldName: 'round_id' },
    gameId: { type: 'string', nullable: true, fieldName: 'game_id' },
    referenceTransactionId: { type: 'string', nullable: true, fieldName: 'reference_transaction_id' },
    referenceId: { type: 'string', nullable: true, fieldName: 'reference_id' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    _failureCode: { type: 'string', nullable: true, fieldName: 'failure_code' },
    createdAt: { type: 'date', fieldName: 'created_at' },
    _updatedAt: { type: 'date', onUpdate: () => new Date(), fieldName: 'updated_at' },
  },
});