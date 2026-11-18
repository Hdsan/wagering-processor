import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessage } from '../../entities/outboxMessage.entity.js';

export const OutboxMessageSchema = new EntitySchema<OutboxMessage>({
  class: OutboxMessage as any,
  tableName: 'outbox_messages',
  indexes: [{ properties: ['_status', '_nextAttemptAt'] as any }],
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateType: { type: 'string', length: 64 },
    aggregateId: { type: 'string', length: 128 },
    eventType: { type: 'string', length: 64 },
    payload: { type: 'json' },
    _status: { type: 'string', length: 16, fieldName: 'status' },
    _attempts: { type: 'number', fieldName: 'attempts', default: 0 },
    _nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at' },
    createdAt: { type: 'Date' },
    _publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
  } as any,
});