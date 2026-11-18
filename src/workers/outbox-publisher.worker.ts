import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../entities/outboxMessage.entity.js';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly sqs: SQSClient;
  private readonly outboxQueueUrl: string;
  private readonly pollIntervalMs = Number(process.env.OUTBOX_POLL_MS || 1000);
  private readonly batchSize = Number(process.env.OUTBOX_BATCH_SIZE || 20);

  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight: Promise<number> | null = null;

  constructor(private readonly em: EntityManager) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });

    this.outboxQueueUrl =
      process.env.SQS_OUTBOX_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-events.fifo';
  }

  onModuleInit() {
    if (process.env.DISABLE_WORKERS === 'true') return;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.inFlight && this.running) {
        this.inFlight = this.publishBatch().finally(() => {
          this.inFlight = null;
        });
      }
    }, this.pollIntervalMs);
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.inFlight) await this.inFlight;
  }

  async publishBatch(): Promise<number> {
    const fork = this.em.fork();
    const now = new Date();
    let publishedCount = 0;

    await fork.transactional(async (txEm) => {
      const pendingMessages = await txEm.find(
        OutboxMessage,
        {
          _status: { $in: ['PENDING', 'FAILED'] },
          $or: [{ _nextAttemptAt: null }, { _nextAttemptAt: { $lte: now } }],
        } as any,
        {
          orderBy: { createdAt: 'ASC' },
          limit: this.batchSize,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );

      if (pendingMessages.length === 0) return;

      const isFifo = this.outboxQueueUrl.endsWith('.fifo');

      for (const msg of pendingMessages) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.outboxQueueUrl,
              MessageBody: JSON.stringify(msg.payload),
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: msg.eventType },
                aggregateId: {
                  DataType: 'String',
                  StringValue: msg.aggregateId,
                },
              },
              ...(isFifo
                ? {
                    MessageGroupId: msg.aggregateId,
                    MessageDeduplicationId: msg.id,
                  }
                : {}),
            }),
          );

          if (typeof (msg as any).markPublished === 'function') {
            (msg as any).markPublished(new Date());
          } else {
            (msg as any)._status = 'PUBLISHED';
            (msg as any)._publishedAt = new Date();
          }

          publishedCount += 1;
        } catch (err: any) {
          this.logger.error(
            JSON.stringify({
              event: 'OUTBOX_PUBLISH_FAILED',
              outboxId: msg.id,
              eventType: msg.eventType,
              aggregateId: msg.aggregateId,
              error: err.message,
            }),
          );

          if (typeof (msg as any).scheduleRetry === 'function') {
            (msg as any).scheduleRetry(new Date());
          } else {
            const attempts = ((msg as any)._attempts ?? 0) + 1;
            const backoffMs = Math.min(60_000, Math.pow(2, attempts) * 1000);
            (msg as any)._attempts = attempts;
            (msg as any)._status = 'FAILED';
            (msg as any)._nextAttemptAt = new Date(Date.now() + backoffMs);
          }
        }
      }
    });

    return publishedCount;
  }
}
