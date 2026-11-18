import { EntitySchema } from '@mikro-orm/core';
import { InboxMessage } from '../../entities/inboxMessage.entity.js';

export const InboxMessageSchema = new EntitySchema<InboxMessage>({
  class: InboxMessage as any,
  tableName: 'inbox_messages',
  uniques: [{ properties: ['consumerName', 'messageId'] }],
  properties: {
    id: { type: 'uuid', primary: true },
    consumerName: { type: 'string', length: 64 },
    messageId: { type: 'string', length: 128 },
    payloadHash: { type: 'string', length: 64 },
    _status: { type: 'string', length: 16, fieldName: 'status' },
    createdAt: { type: 'Date' },
  } as any,
});