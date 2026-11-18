import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { ProcessWagerUseCase } from '../usecases/ProcessWagerUseCase.js';
import { WagerTransactionKind } from '../entities/wagerTransaction.entity.js';

interface SqsWagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId?: string;
    roundId?: string;
    gameId?: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly maxAttempts = Number(process.env.SQS_MAX_ATTEMPTS || 5);
  private readonly consumerName = 'SqsWagerConsumer';

  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly processWagerUseCase: ProcessWagerUseCase,
  ) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });

    this.queueUrl =
      process.env.SQS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqUrl =
      process.env.SQS_DLQ_URL ||
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
  }

  onModuleInit() {
    if (process.env.DISABLE_WORKERS === 'true') return;
    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            MessageAttributeNames: ['All'],
          }),
        );

        const messages = response.Messages ?? [];
        for (const msg of messages) {
          if (!this.running) {
           
            if (msg.ReceiptHandle) {
              await this.sqs
                .send(
                  new ChangeMessageVisibilityCommand({
                    QueueUrl: this.queueUrl,
                    ReceiptHandle: msg.ReceiptHandle,
                    VisibilityTimeout: 0,
                  }),
                )
                .catch(() => {});
            }
            break;
          }

          await this.handleMessage(msg);
        }
      } catch (err: any) {
        if (!this.running) break;
        this.logger.error(
          JSON.stringify({
            event: 'SQS_POLL_ERROR',
            error: err.message,
          }),
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async handleMessage(msg: Message): Promise<void> {
    if (!msg.Body || !msg.ReceiptHandle) return;

    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount || '1');
    const correlationId =
      msg.MessageAttributes?.correlationId?.StringValue || randomUUID();

    let envelope: SqsWagerEnvelope;
    try {
      envelope = JSON.parse(msg.Body) as SqsWagerEnvelope;
      if (
        !envelope?.messageId ||
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.data?.providerId ||
        !envelope.data?.externalTransactionId ||
        !envelope.data?.playerId ||
        !envelope.data?.kind ||
        typeof envelope.data?.money?.amount !== 'string' ||
        typeof envelope.data?.money?.currency !== 'string'
      ) {
        throw new Error('PERMANENT_INVALID_ENVELOPE');
      }
    } catch (parseErr: any) {
      await this.sendToDlqAndAck(
        msg,
        'MALFORMED_MESSAGE',
        parseErr.message,
        correlationId,
      );
      return;
    }

    const data = envelope.data;
    const idempotencyKey =
      data.idempotencyKey?.trim() ||
      `${data.providerId}:${data.externalTransactionId}`;

    try {
      const result = await RequestContext.create(this.em, () =>
        this.processWagerUseCase.execute({
          idempotencyKey,
          provider: data.providerId,
          externalTransactionId: data.externalTransactionId,
          playerId: data.playerId,
          walletId: data.walletId,
          roundId: data.roundId,
          gameId: data.gameId,
          kind: data.kind,
          amount: data.money.amount,
          currency: data.money.currency,
          referenceTransactionId: data.referenceExternalTransactionId,
          correlationId,
          inboxContext: {
            consumerName: this.consumerName,
            messageId: envelope.messageId,
          },
        }),
      );

      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'SQS_MESSAGE_PROCESSED',
          correlationId,
          messageId: envelope.messageId,
          transactionId: result.transactionId,
          walletId: data.walletId ?? null,
          providerId: data.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        }),
      );
    } catch (err: any) {
      if (this.isBusinessError(err)) {
      
        this.logger.warn(
          JSON.stringify({
            event: 'SQS_MESSAGE_BUSINESS_REJECTED',
            correlationId,
            messageId: envelope.messageId,
            providerId: data.providerId,
            reason: err.message,
          }),
        );

        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
        return;
      }

      if (receiveCount >= this.maxAttempts) {
        await this.sendToDlqAndAck(
          msg,
          'MAX_RETRIES_EXCEEDED',
          err.message,
          correlationId,
        );
        return;
      }

      const backoffSeconds = Math.min(60, Math.pow(2, receiveCount));
      this.logger.warn(
        JSON.stringify({
          event: 'SQS_MESSAGE_RETRY_SCHEDULED',
          correlationId,
          messageId: envelope.messageId,
          providerId: data.providerId,
          attempt: receiveCount,
          backoffSeconds,
        }),
      );

      await this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle,
            VisibilityTimeout: backoffSeconds,
          }),
        )
        .catch(() => {});
    }
  }

  private isBusinessError(err: any): boolean {
    const msg = String(err?.message || '');
    return (
      msg.startsWith('IDEMPOTENCY_CONFLICT') ||
      msg.startsWith('VALIDATION_ERROR') ||
      msg.startsWith('UNSUPPORTED_KIND') ||
      msg.includes('Invalid money') ||
      msg.includes('Invalid currency') ||
      msg.includes('Currency mismatch')
    );
  }

  private async sendToDlqAndAck(
    msg: Message,
    reason: string,
    detail: string,
    correlationId: string,
  ): Promise<void> {
    this.logger.error(
      JSON.stringify({
        event: 'SQS_MESSAGE_MOVED_TO_DLQ',
        correlationId,
        sqsMessageId: msg.MessageId,
        reason,
        detail,
      }),
    );

    const isFifo = this.dlqUrl.endsWith('.fifo');

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: msg.Body!,
        ...(isFifo
          ? {
              MessageGroupId: 'dlq',
              MessageDeduplicationId: msg.MessageId || randomUUID(),
            }
          : {}),
        MessageAttributes: {
          dlqReason: { DataType: 'String', StringValue: reason },
          correlationId: { DataType: 'String', StringValue: correlationId },
        },
      }),
    );

    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: msg.ReceiptHandle!,
      }),
    );
  }
}
