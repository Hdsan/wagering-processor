import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../common/class/Money.js';
import { Wallet } from '../entities/wallet.entity.js';
import { WagerTransaction } from '../entities/wagerTransaction.entity.js';
import { WalletLedgerEntry } from '../entities/walletLedgerEntry.entity.js';
import { OutboxMessage } from '../entities/outboxMessage.entity.js';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight: Promise<void> | null = null;

  private readonly pollIntervalMs = Number(
    process.env.PENDING_REF_POLL_MS || 2000,
  );
  private readonly baseBackoffMs = Number(
    process.env.PENDING_REF_BACKOFF_MS || 1000,
  );
  private readonly ttlMs = Number(process.env.PENDING_REF_TTL_MS || 300_000);

  constructor(private readonly em: EntityManager) {}

  onModuleInit() {
    if (process.env.DISABLE_WORKERS === 'true') return;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.inFlight && this.running) {
        this.inFlight = this.tick().finally(() => {
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

  async tick(): Promise<void> {
    const fork = this.em.fork();
    const now = new Date();

    const candidates = await fork.find(
      WagerTransaction,
      { status: 'PENDING_REFERENCE' },
      { orderBy: { createdAt: 'ASC' }, limit: 25 },
    );

    for (const candidate of candidates) {
      if (!this.isDueForRetry(candidate, now)) continue;

      try {
        await this.processSingle(candidate.id, now);
      } catch (err: any) {
        this.logger.error(
          JSON.stringify({
            event: 'PENDING_REFERENCE_WORKER_ERROR',
            transactionId: candidate.id,
            error: err.message,
          }),
        );
      }
    }
  }

  private isDueForRetry(tx: WagerTransaction, now: Date): boolean {
    const ageMs = now.getTime() - tx.createdAt.getTime();
    if (ageMs >= this.ttlMs) return true;

    const elapsedSinceCreation = Math.max(
      0,
      tx.updatedAt.getTime() - tx.createdAt.getTime(),
    );
    const requiredDelay = Math.min(
      30_000,
      Math.max(this.baseBackoffMs, elapsedSinceCreation * 2),
    );
    return now.getTime() - tx.updatedAt.getTime() >= requiredDelay;
  }

  private async processSingle(transactionId: string, now: Date): Promise<void> {
    const fork = this.em.fork();

    await fork.transactional(async (txEm) => {
      const pendingTx = await txEm.findOne(
        WagerTransaction,
        { id: transactionId, status: 'PENDING_REFERENCE' },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );

      if (!pendingTx) return;

      const correlationId = randomUUID();
      const money = Money.fromDecimal(pendingTx.amount, pendingTx.currency);

      const originalTx = pendingTx.referenceTransactionId
        ? await txEm.findOne(WagerTransaction, {
            provider: pendingTx.provider,
            playerId: pendingTx.playerId,
            $or: [
              { idempotencyKey: pendingTx.referenceTransactionId },
              { externalTransactionId: pendingTx.referenceTransactionId },
            ],
          })
        : null;

      if (!originalTx) {
        const ageMs = now.getTime() - pendingTx.createdAt.getTime();
        if (ageMs >= this.ttlMs) {
          this.rejectPending(
            txEm,
            pendingTx,
            money,
            correlationId,
            'REFERENCE_NOT_FOUND_EXPIRED',
          );
          return;
        }

        pendingTx.updatedAt = now;
        return;
      }

      if (originalTx.status !== 'PROCESSED') {
        this.rejectPending(
          txEm,
          pendingTx,
          money,
          correlationId,
          'ORIGINAL_TRANSACTION_NOT_PROCESSED',
        );
        return;
      }

      const validTarget =
        (pendingTx.kind === 'REFUND' && originalTx.kind === 'BET') ||
        (pendingTx.kind === 'ROLLBACK' &&
          ['BET', 'WIN', 'REFUND'].includes(originalTx.kind));

      if (
        !validTarget ||
        originalTx.currency !== money.currency ||
        (pendingTx.roundId &&
          originalTx.roundId &&
          originalTx.roundId !== pendingTx.roundId) ||
        !originalTx.amount.equals(money.toDecimal())
      ) {
        this.rejectPending(
          txEm,
          pendingTx,
          money,
          correlationId,
          'REFERENCE_MISMATCH',
        );
        return;
      }

      const wallet = await txEm.findOne(
        Wallet,
        { playerId: pendingTx.playerId, currency: money.currency },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!wallet) {
        this.rejectPending(
          txEm,
          pendingTx,
          money,
          correlationId,
          'WALLET_NOT_FOUND',
        );
        return;
      }

      const isCreditReversal = originalTx.kind === 'BET';
      const beforeBalance = wallet.balance;

      if (isCreditReversal) {
        wallet.credit(money);
      } else {
        if (wallet.balance.isLessThan(money)) {
          this.rejectPending(
            txEm,
            pendingTx,
            money,
            correlationId,
            'INSUFFICIENT_FUNDS_FOR_ROLLBACK',
          );
          return;
        }
        wallet.debit(money);
      }

      pendingTx.markProcessed(now);
      pendingTx.walletId = wallet.id;
      pendingTx.updatedAt = now;

      const ledgerDirection = isCreditReversal ? 'CREDIT' : 'DEBIT';

      txEm.persist(
        WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: pendingTx.id,
          type: ledgerDirection,
          amount: money,
          balanceBefore: beforeBalance,
        }),
      );

      txEm.persist(
        OutboxMessage.create({
          id: randomUUID(),
          aggregateType: 'Wallet',
          aggregateId: wallet.id,
          eventType: 'WalletBalanceChanged',
          payload: {
            eventId: randomUUID(),
            eventType: 'WalletBalanceChanged',
            aggregateId: wallet.id,
            correlationId,
            causationId: pendingTx.id,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              walletId: wallet.id,
              transactionId: pendingTx.id,
              direction: ledgerDirection,
              money: money.toJSON(),
              balanceBefore: beforeBalance.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          },
        }),
      );

      txEm.persist(
        OutboxMessage.create({
          id: randomUUID(),
          aggregateType: 'WagerTransaction',
          aggregateId: pendingTx.id,
          eventType: 'WagerTransactionProcessed',
          payload: {
            eventId: randomUUID(),
            eventType: 'WagerTransactionProcessed',
            aggregateId: pendingTx.id,
            correlationId,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              transactionId: pendingTx.id,
              idempotencyKey: pendingTx.idempotencyKey,
              playerId: pendingTx.playerId,
              walletId: wallet.id,
              kind: pendingTx.kind,
              money: money.toJSON(),
              status: 'PROCESSED',
              balance: wallet.balance.toJSON(),
            },
          },
        }),
      );
    });
  }

  private rejectPending(
    txEm: EntityManager,
    pendingTx: WagerTransaction,
    money: Money,
    correlationId: string,
    failureCode: string,
  ) {
    pendingTx.reject(failureCode, new Date());

    txEm.persist(
      OutboxMessage.create({
        id: randomUUID(),
        aggregateType: 'WagerTransaction',
        aggregateId: pendingTx.id,
        eventType: 'WagerTransactionRejected',
        payload: {
          eventId: randomUUID(),
          eventType: 'WagerTransactionRejected',
          aggregateId: pendingTx.id,
          correlationId,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {
            transactionId: pendingTx.id,
            idempotencyKey: pendingTx.idempotencyKey,
            playerId: pendingTx.playerId,
            walletId: pendingTx.walletId ?? null,
            kind: pendingTx.kind,
            money: money.toJSON(),
            status: 'REJECTED',
            failureCode,
          },
        },
      }),
    );
  }
}
