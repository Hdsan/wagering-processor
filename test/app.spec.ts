import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Money } from '../src/common/class/Money.js';
import { ProcessWagerUseCase } from '../src/usecases/ProcessWagerUseCase.js';
import { Wallet } from '../src/entities/wallet.entity.js';
import { WalletLedgerEntry } from '../src/entities/walletLedgerEntry.entity.js';
import { InboxMessage } from '../src/entities/inboxMessage.entity.js';
import { OutboxMessage } from '../src/entities/outboxMessage.entity.js';
import { Decimal } from 'decimal.js';

import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { SqsWagerConsumer } from '../src/messaging/sqsWager.consumer.js';

describe('Jungle Gaming — Distributed Wagering Processor (Integration & Concurrency)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let useCase: ProcessWagerUseCase;
  let sqsConsumer: SqsWagerConsumer;
  let sqs: SQSClient;

  const queueUrl =
    process.env.SQS_QUEUE_URL ||
    'http://localhost:4566/000000000000/wager-transactions.fifo';
  const dlqUrl =
    process.env.SQS_DLQ_URL ||
    'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

  async function assertAllWalletsMatchLedger() {
    const em = orm.em.fork() as EntityManager;
    const wallets = await em.find(Wallet, {});
    for (const wallet of wallets) {
      const entries = await em.find(
        WalletLedgerEntry,
        { walletId: wallet.id },
        { orderBy: { createdAt: 'ASC', id: 'ASC' } },
      );

      let calculated = new Decimal(0);
      for (const entry of entries) {
        const amt = entry.amount.toDecimal();
        calculated = entry.type === 'CREDIT' ? calculated.plus(amt) : calculated.minus(amt);
      }

      expect(wallet.balance.toDecimal().equals(calculated)).toBe(true);
    }
  }

  beforeAll(async () => {
    process.env.DISABLE_WORKERS = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    orm = moduleRef.get(MikroORM);
    useCase = moduleRef.get(ProcessWagerUseCase);
    sqsConsumer = moduleRef.get(SqsWagerConsumer);

    sqs = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    for (const name of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo']) {
      await sqs
        .send(
          new CreateQueueCommand({
            QueueName: name,
            Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
          }),
        )
        .catch(() => {});
    }
  });

  beforeEach(async () => {
    const em = orm.em.fork() as EntityManager;
    await em
      .getConnection()
      .execute(
        'TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;',
      );

    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
    await sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl })).catch(() => {});
  });

  afterAll(async () => {
    await assertAllWalletsMatchLedger();
    await app.close();
  });

  it('1. Money: rejeita number, negativos, >2 casas decimais e conflito de moeda', () => {
    expect(() => Money.of(10 as any, 'BRL')).toThrow();
    expect(() => Money.of('-10.00', 'BRL')).toThrow();
    expect(() => Money.of('10.123', 'BRL')).toThrow();
    expect(() => Money.from({ amount: '010.00', currency: 'BRL' })).toThrow();

    const brl = Money.from({ amount: '10.50', currency: 'BRL' });
    const usd = Money.from({ amount: '10.50', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(/Currency mismatch/);
    expect(brl.toJSON()).toEqual({ amount: '10.50', currency: 'BRL' });
  });

  it('2. Cenário obrigatório Seção 8: 100.00 BRL com duas apostas de 80.00 BRL em paralelo', async () => {
    const playerId = randomUUID();

    const walletRes = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    const walletId = walletRes.body.id;
    expect(walletRes.body.version).toBe(1);

    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `prov-a:bet-1-${playerId}`)
        .send({
          providerId: 'prov-a',
          externalTransactionId: `bet-1-${playerId}`,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        }),
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `prov-a:bet-2-${playerId}`)
        .send({
          providerId: 'prov-a',
          externalTransactionId: `bet-2-${playerId}`,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 422]);

    const walletGet = await request(app.getHttpServer())
      .get(`/wallets/${walletId}`)
      .expect(200);

    expect(walletGet.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const em = orm.em.fork() as EntityManager;
    const debits = await em.find(WalletLedgerEntry, { walletId, type: 'DEBIT' });
    expect(debits).toHaveLength(1);

    await assertAllWalletsMatchLedger();
  });

  it('3. Concorrência: mesma aposta enviada 50 vezes em paralelo -> 1 único débito', async () => {
    const playerId = randomUUID();

    const walletRes = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      })
      .expect(201);

    const walletId = walletRes.body.id;
    const sharedKey = `prov-a:dup-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        RequestContext.create(orm.em, () =>
          useCase.execute({
            idempotencyKey: sharedKey,
            provider: 'prov-a',
            externalTransactionId: `ext-${sharedKey}`,
            playerId,
            walletId,
            roundId: 'round-50',
            gameId: 'fortune-chimp',
            kind: 'BET',
            amount: '30.00',
            currency: 'BRL',
          }),
        ),
      ),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);

    const em = orm.em.fork() as EntityManager;
    const wallet = await em.findOneOrFail(Wallet, { id: walletId });
    expect(wallet.balance.toString()).toBe('170.00');

    const ledgerEntries = await em.find(WalletLedgerEntry, { walletId });
    expect(ledgerEntries).toHaveLength(2);

    await assertAllWalletsMatchLedger();
  });

  it('4. LOSS não altera saldo nem gera ledger, mas emite WagerTransactionProcessed', async () => {
    const playerId = randomUUID();
    const walletRes = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })
      .expect(201);

    const walletId = walletRes.body.id;

    const lossRes = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:loss-${playerId}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: `loss-${playerId}`,
        playerId,
        walletId,
        roundId: 'round-loss',
        gameId: 'fortune-chimp',
        kind: 'LOSS',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(200);

    expect(lossRes.body.status).toBe('PROCESSED');
    expect(lossRes.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });

    const em = orm.em.fork() as EntityManager;
    const entries = await em.find(WalletLedgerEntry, { walletId });
    expect(entries).toHaveLength(1);

    const balanceEvents = await em.count(OutboxMessage, {
      aggregateId: walletId,
      eventType: 'WalletBalanceChanged',
    } as any);
    expect(balanceEvents).toBe(0);

    await assertAllWalletsMatchLedger();
  });

  it('5. Reversão fora de ordem (PENDING_REFERENCE) e ROLLBACK bloqueado se causar saldo negativo', async () => {
    const playerId = randomUUID();
    const walletRes = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    const walletId = walletRes.body.id;
    const betExtId = `bet-ooo-${randomUUID()}`;

    const earlyRefund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:refund-${randomUUID()}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: `refund-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-ooo',
        gameId: 'fortune-chimp',
        kind: 'REFUND',
        referenceExternalTransactionId: betExtId,
        money: { amount: '40.00', currency: 'BRL' },
      })
      .expect(202);

    expect(earlyRefund.body.status).toBe('PENDING_REFERENCE');

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:${betExtId}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: betExtId,
        playerId,
        walletId,
        roundId: 'round-ooo',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      })
      .expect(200);

    const winExtId = `win-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:${winExtId}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: winExtId,
        playerId,
        walletId,
        roundId: 'round-win',
        gameId: 'fortune-chimp',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:bet-spend-${randomUUID()}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: `bet-spend-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-spend',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '130.00', currency: 'BRL' },
      })
      .expect(200);

    const rollbackRes = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `prov-a:rb-${randomUUID()}`)
      .send({
        providerId: 'prov-a',
        externalTransactionId: `rb-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-win',
        gameId: 'fortune-chimp',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: winExtId,
        money: { amount: '50.00', currency: 'BRL' },
      })
      .expect(422);

    expect(rollbackRes.body.failureCode).toBe('INSUFFICIENT_FUNDS_FOR_ROLLBACK');

    const recon = await request(app.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200);

    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance).toEqual({ amount: '20.00', currency: 'BRL' });

    await assertAllWalletsMatchLedger();
  });

  it('6. SQS Real: processa envelope, deduplica redelivery via Inbox e envia payload inválido para DLQ', async () => {
    const playerId = randomUUID();
    const walletRes = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    const walletId = walletRes.body.id;
    const msgId = `msg-${randomUUID()}`;
    const extId = `sqs-bet-${randomUUID()}`;

    const validEnvelope = JSON.stringify({
      messageId: msgId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: extId,
        idempotencyKey: `provider-a:${extId}`,
        playerId,
        walletId,
        roundId: 'round-sqs',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });

    for (let i = 0; i < 2; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: validEnvelope,
          MessageGroupId: walletId,
          MessageDeduplicationId: `${msgId}-${i}`,
        }),
      );
    }

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{"broken":true}',
        MessageGroupId: 'broken-group',
        MessageDeduplicationId: `bad-${randomUUID()}`,
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
    );

    for (const m of received.Messages ?? []) {
      await sqsConsumer.handleMessage(m);
    }

    const em = orm.em.fork() as EntityManager;
    const wallet = await em.findOneOrFail(Wallet, { id: walletId });
    expect(wallet.balance.toString()).toBe('75.00');

    const inboxCount = await em.count(InboxMessage, { messageId: msgId });
    expect(inboxCount).toBe(1);

    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    expect(Number(dlqAttrs.Attributes?.ApproximateNumberOfMessages || '0')).toBeGreaterThanOrEqual(1);

    await assertAllWalletsMatchLedger();
  });
});