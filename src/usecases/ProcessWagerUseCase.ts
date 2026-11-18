import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../common/class/Money.js';
import { Wallet } from '../entities/wallet.entity.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../entities/wagerTransaction.entity.js';
import { WalletLedgerEntry } from '../entities/walletLedgerEntry.entity.js';
import { InboxMessage } from '../entities/inboxMessage.entity.js';
import { OutboxMessage } from '../entities/outboxMessage.entity.js';
import { MetricsService } from '../common/observability/metrics.service.js';


export interface ProcessWagerCommand {
  idempotencyKey: string;
  playerId: string;
  walletId?: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  provider?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  referenceTransactionId?: string;
  correlationId?: string;
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerResult {
  transactionId: string;
  idempotencyKey: string;
  status: string;
  balance: string;
  currency: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

@Injectable()
export class ProcessWagerUseCase {
  private readonly logger = new Logger(ProcessWagerUseCase.name);

  constructor(private readonly em: EntityManager, @Optional() private readonly metrics?: MetricsService,) {}

  async execute(cmd: ProcessWagerCommand): Promise<ProcessWagerResult> {
    if ((cmd.kind as string) === 'OPENING') {
      throw new Error(
        'VALIDATION_ERROR: OPENING is an internal operation and cannot be submitted.',
      );
    }

    if (typeof (cmd.amount as unknown) !== 'string') {
      throw new Error(
        'VALIDATION_ERROR: amount must be a decimal string, never a number.',
      );
    }

    const money = Money.of(cmd.amount, cmd.currency);

    if (cmd.kind !== 'LOSS' && (money.isNegative() || money.isZero())) {
      throw new Error('VALIDATION_ERROR: amount must be greater than zero.');
    }

    const provider = cmd.provider?.trim() || 'default';
    const correlationId = cmd.correlationId || randomUUID();
    const payloadHash = this.computePayloadHash(cmd, money, provider);
    try {
      return await this.em.transactional(async (txEm) => {
        const existing = await txEm.findOne(WagerTransaction, {
          $or: [
            { idempotencyKey: cmd.idempotencyKey },
            ...(cmd.externalTransactionId
              ? [{ provider, externalTransactionId: cmd.externalTransactionId }]
              : []),
          ],
        });

        if (existing) {
                    if (existing.payloadHash !== payloadHash) {
            throw new Error(
              `IDEMPOTENCY_CONFLICT: key "${cmd.idempotencyKey}" already used with a different payload.`,
            );
          }

          const wallet = existing.walletId
            ? await txEm.findOne(Wallet, { id: existing.walletId })
            : await txEm.findOne(Wallet, {
                playerId: existing.playerId,
                currency: existing.currency,
              });

          await this.recordInboxIfPresent(txEm, cmd, payloadHash);

          const ledgerEntry = await txEm.findOne(WalletLedgerEntry, {
            transactionId: existing.id,
          });

          const balanceAtTheTime = ledgerEntry
            ? ledgerEntry.balanceAfter.toString()
            : wallet
              ? wallet.balance.toString()
              : '0.00';

          return {
            transactionId: existing.id,
            idempotencyKey: existing.idempotencyKey,
            status: existing.status,
            balance: balanceAtTheTime,
            currency: existing.currency,
            idempotentReplay: true,
            failureCode: existing.failureCode,
          };
        }

        let wallet: Wallet | null = null;

        if (cmd.walletId) {
          wallet = await txEm.findOne(
            Wallet,
            { id: cmd.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );

          if (!wallet) {
            throw new Error(
              `VALIDATION_ERROR: wallet "${cmd.walletId}" not found.`,
            );
          }
          if (wallet.playerId !== cmd.playerId) {
            throw new Error(
              'VALIDATION_ERROR: walletId does not belong to playerId.',
            );
          }
          if (wallet.currency !== money.currency) {
            throw new Error(
              `Currency mismatch: wallet currency is ${wallet.currency}, operation is ${money.currency}.`,
            );
          }
        } else {
          wallet = await txEm.findOne(
            Wallet,
            { playerId: cmd.playerId, currency: money.currency },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );

          if (!wallet) {
            wallet = Wallet.open({
              id: randomUUID(),
              playerId: cmd.playerId,
              initialBalance: Money.zero(money.currency),
            });
            txEm.persist(wallet);
            await txEm.flush();

            wallet = (await txEm.findOne(
              Wallet,
              { id: wallet.id },
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            ))!;
          }
        }

        if (cmd.kind === 'REFUND' || cmd.kind === 'ROLLBACK') {
          return this.handleReversal(
            txEm,
            wallet,
            cmd,
            money,
            provider,
            payloadHash,
            correlationId,
          );
        }

        const balanceBefore = wallet.balance;
        let status: 'PROCESSED' | 'REJECTED' = 'PROCESSED';
        let failureCode: string | undefined;
        let balanceChanged = false;

        if (cmd.kind === 'BET') {
          if (wallet.balance.isLessThan(money)) {
            status = 'REJECTED';
            failureCode = 'INSUFFICIENT_FUNDS';
          } else {
            wallet.debit(money);
            balanceChanged = true;
          }
        } else if (cmd.kind === 'WIN') {
          wallet.credit(money);
          balanceChanged = true;
        } else if (cmd.kind === 'LOSS') {
          status = 'PROCESSED';
          balanceChanged = false;
        } else {
          throw new Error(`UNSUPPORTED_KIND: ${cmd.kind}`);
        }

        const transaction = WagerTransaction.create({
          id: randomUUID(),
          idempotencyKey: cmd.idempotencyKey,
          walletId: wallet.id,
          playerId: cmd.playerId,
          kind: cmd.kind,
          amount: money.toDecimal(),
          currency: money.currency,
          status,
          provider,
          externalTransactionId: cmd.externalTransactionId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          referenceTransactionId: cmd.referenceTransactionId,
          payloadHash,
          failureCode,
        });
        txEm.persist(transaction);

        if (status === 'PROCESSED' && balanceChanged) {
          const ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            type: cmd.kind === 'BET' ? 'DEBIT' : 'CREDIT',
            amount: money,
            balanceBefore,
          });
          txEm.persist(ledgerEntry);

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
                causationId: transaction.id,
                occurredAt: new Date().toISOString(),
                version: 1,
                data: {
                  walletId: wallet.id,
                  transactionId: transaction.id,
                  direction: ledgerEntry.type,
                  money: money.toJSON(),
                  balanceBefore: balanceBefore.toJSON(),
                  balanceAfter: wallet.balance.toJSON(),
                  walletVersion: wallet.version,
                },
              },
            }),
          );
        }

        if (cmd.kind === 'BET' && status === 'PROCESSED') {
          const refKeys = [
            cmd.idempotencyKey,
            cmd.externalTransactionId,
          ].filter((v): v is string => Boolean(v));

          if (refKeys.length > 0) {
            const pendingReversal = await txEm.findOne(WagerTransaction, {
              status: 'PENDING_REFERENCE',
              referenceTransactionId: { $in: refKeys },
            });

            if (pendingReversal) {
              const pendingDecimal =
                pendingReversal.amount instanceof Money
                  ? pendingReversal.amount.toDecimal()
                  : pendingReversal.amount;

              if (
                pendingReversal.currency !== money.currency ||
                !pendingDecimal.equals(money.toDecimal())
              ) {
                throw new Error(
                  'PENDING_REFERENCE_MISMATCH: amount or currency does not match pending reversal.',
                );
              }

              const refundMoney = Money.fromDecimal(
                pendingDecimal,
                pendingReversal.currency,
              );
              
              const beforeRefund = wallet.balance;
              wallet.credit(refundMoney);

              pendingReversal.markProcessed(new Date());
              this.metrics?.recordTransaction('PROCESSED', 0, false);
              pendingReversal.walletId = wallet.id;

              const refundLedger = WalletLedgerEntry.create({
                id: randomUUID(),
                walletId: wallet.id,
                transactionId: pendingReversal.id,
                type: 'CREDIT',
                amount: refundMoney,
                balanceBefore: beforeRefund,
              });
              txEm.persist(refundLedger);

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
                    causationId: pendingReversal.id,
                    occurredAt: new Date().toISOString(),
                    version: 1,
                    data: {
                      walletId: wallet.id,
                      transactionId: pendingReversal.id,
                      direction: 'CREDIT',
                      money: refundMoney.toJSON(),
                      balanceBefore: beforeRefund.toJSON(),
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
                  aggregateId: pendingReversal.id,
                  eventType: 'WagerTransactionProcessed',
                  payload: {
                    eventId: randomUUID(),
                    eventType: 'WagerTransactionProcessed',
                    aggregateId: pendingReversal.id,
                    correlationId,
                    occurredAt: new Date().toISOString(),
                    version: 1,
                    data: {
                      transactionId: pendingReversal.id,
                      idempotencyKey: pendingReversal.idempotencyKey,
                      playerId: pendingReversal.playerId,
                      walletId: wallet.id,
                      kind: pendingReversal.kind,
                      money: refundMoney.toJSON(),
                      status: 'PROCESSED',
                      balance: wallet.balance.toJSON(),
                    },
                  },
                }),
              );
            }
          }
        }

        const txEventType =
          transaction.status === 'PROCESSED'
            ? 'WagerTransactionProcessed'
            : 'WagerTransactionRejected';

        txEm.persist(
          OutboxMessage.create({
            id: randomUUID(),
            aggregateType: 'WagerTransaction',
            aggregateId: transaction.id,
            eventType: txEventType,
            payload: {
              eventId: randomUUID(),
              eventType: txEventType,
              aggregateId: transaction.id,
              correlationId,
              occurredAt: new Date().toISOString(),
              version: 1,
              data: {
                transactionId: transaction.id,
                idempotencyKey: transaction.idempotencyKey,
                playerId: transaction.playerId,
                walletId: wallet.id,
                kind: transaction.kind,
                money: money.toJSON(),
                status: transaction.status,
                failureCode: transaction.failureCode ?? null,
                balance: wallet.balance.toJSON(),
              },
            },
          }),
        );

        await this.recordInboxIfPresent(txEm, cmd, payloadHash);
    this.metrics?.recordTransaction('PROCESSED', 0, false);       
     return {
          transactionId: transaction.id,
          idempotencyKey: transaction.idempotencyKey,
          status: transaction.status,
          balance: wallet.balance.toString(),
          currency: wallet.currency,
          idempotentReplay: false,
          failureCode: transaction.failureCode,
        };
      });
    } catch (err: any) {
      const isUniqueViolation =
        err?.code === '23505' ||
        err?.name === 'UniqueConstraintViolationException' ||
        String(err?.message).includes(
          'wager_transactions_idempotency_key_unique',
        );

      if (isUniqueViolation) {
        this.metrics?.recordConflict();
        const forkEm = this.em.fork();
        const existing = await forkEm.findOneOrFail(WagerTransaction, {
          idempotencyKey: cmd.idempotencyKey,
        });

        if (existing.payloadHash !== payloadHash) {
          throw new Error(
            `IDEMPOTENCY_CONFLICT: key "${cmd.idempotencyKey}" already used with a different payload.`,
          );
        }

        const wallet = existing.walletId
          ? await forkEm.findOne(Wallet, { id: existing.walletId })
          : await forkEm.findOne(Wallet, {
              playerId: existing.playerId,
              currency: existing.currency,
            });

        return {
          transactionId: existing.id,
          idempotencyKey: existing.idempotencyKey,
          status: existing.status,
          balance: wallet ? wallet.balance.toString() : '0.00',
          currency: existing.currency,
          idempotentReplay: true,
          failureCode: existing.failureCode,
        };
      }
      throw err;
    }
  }

  private async handleReversal(
    txEm: EntityManager,
    wallet: Wallet,
    cmd: ProcessWagerCommand,
    money: Money,
    provider: string,
    payloadHash: string,
    correlationId: string,
  ): Promise<ProcessWagerResult> {
    if (!cmd.referenceTransactionId) {
      throw new Error(
        'VALIDATION_ERROR: referenceTransactionId is required for REFUND/ROLLBACK.',
      );
    }

    const alreadyReversed = await txEm.findOne(WagerTransaction, {
      referenceTransactionId: cmd.referenceTransactionId,
      kind: cmd.kind,
      status: { $in: ['PROCESSED', 'PENDING_REFERENCE'] },
    });

    if (alreadyReversed) {
      return this.rejectAndPersist(
        txEm,
        wallet,
        cmd,
        money,
        provider,
        payloadHash,
        correlationId,
        'DUPLICATE_REVERSAL',
      );
    }

    const originalTx = await txEm.findOne(WagerTransaction, {
      provider,
      playerId: cmd.playerId,
      $or: [
        { idempotencyKey: cmd.referenceTransactionId },
        { externalTransactionId: cmd.referenceTransactionId },
      ],
    });

    if (!originalTx) {
      const pendingTx = WagerTransaction.create({
        id: randomUUID(),
        idempotencyKey: cmd.idempotencyKey,
        walletId: wallet.id,
        playerId: cmd.playerId,
        kind: cmd.kind,
        amount: money.toDecimal(),
        currency: money.currency,
        status: 'PENDING_REFERENCE',
        provider,
        externalTransactionId: cmd.externalTransactionId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        referenceTransactionId: cmd.referenceTransactionId,
        payloadHash,
      });
      txEm.persist(pendingTx);

      txEm.persist(
        OutboxMessage.create({
          id: randomUUID(),
          aggregateType: 'WagerTransaction',
          aggregateId: pendingTx.id,
          eventType: 'WagerTransactionPendingReference',
          payload: {
            eventId: randomUUID(),
            eventType: 'WagerTransactionPendingReference',
            aggregateId: pendingTx.id,
            correlationId,
            occurredAt: new Date().toISOString(),
            version: 1,
            data: {
              transactionId: pendingTx.id,
              playerId: pendingTx.playerId,
              walletId: wallet.id,
              kind: pendingTx.kind,
              referenceTransactionId: pendingTx.referenceTransactionId,
              money: money.toJSON(),
            },
          },
        }),
      );

      await this.recordInboxIfPresent(txEm, cmd, payloadHash);

      return {
        transactionId: pendingTx.id,
        idempotencyKey: pendingTx.idempotencyKey,
        status: 'PENDING_REFERENCE',
        balance: wallet.balance.toString(),
        currency: wallet.currency,
        idempotentReplay: false,
      };
    }

    if (originalTx.status !== 'PROCESSED') {
      return this.rejectAndPersist(
        txEm,
        wallet,
        cmd,
        money,
        provider,
        payloadHash,
        correlationId,
        'ORIGINAL_TRANSACTION_NOT_PROCESSED',
      );
    }

    const originalAmountDecimal =
      originalTx.amount instanceof Money
        ? originalTx.amount.toDecimal()
        : originalTx.amount;

    if (
      originalTx.currency !== money.currency ||
      (cmd.roundId &&
        originalTx.roundId &&
        originalTx.roundId !== cmd.roundId) ||
      !originalAmountDecimal.equals(money.toDecimal())
    ) {
      return this.rejectAndPersist(
        txEm,
        wallet,
        cmd,
        money,
        provider,
        payloadHash,
        correlationId,
        'REFERENCE_MISMATCH',
      );
    }

    if (cmd.kind === 'REFUND' && originalTx.kind !== 'BET') {
      return this.rejectAndPersist(
        txEm,
        wallet,
        cmd,
        money,
        provider,
        payloadHash,
        correlationId,
        'INVALID_REFUND_TARGET',
      );
    }

    if (
      cmd.kind === 'ROLLBACK' &&
      !['BET', 'WIN', 'REFUND'].includes(originalTx.kind)
    ) {
      return this.rejectAndPersist(
        txEm,
        wallet,
        cmd,
        money,
        provider,
        payloadHash,
        correlationId,
        'INVALID_ROLLBACK_TARGET',
      );
    }

    const isCreditReversal = originalTx.kind === 'BET';
    const beforeReversal = wallet.balance;

    if (isCreditReversal) {
      wallet.credit(money);
    } else {
      if (wallet.balance.isLessThan(money)) {
        return this.rejectAndPersist(
          txEm,
          wallet,
          cmd,
          money,
          provider,
          payloadHash,
          correlationId,
          'INSUFFICIENT_FUNDS_FOR_ROLLBACK',
        );
      }
      wallet.debit(money);
    }

    const reversalTx = WagerTransaction.create({
      id: randomUUID(),
      idempotencyKey: cmd.idempotencyKey,
      walletId: wallet.id,
      playerId: cmd.playerId,
      kind: cmd.kind,
      amount: money.toDecimal(),
      currency: money.currency,
      status: 'PROCESSED',
      provider,
      externalTransactionId: cmd.externalTransactionId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      referenceTransactionId: cmd.referenceTransactionId,
      payloadHash,
    });
    txEm.persist(reversalTx);

    const ledgerDirection = isCreditReversal ? 'CREDIT' : 'DEBIT';

    txEm.persist(
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: reversalTx.id,
        type: ledgerDirection,
        amount: money,
        balanceBefore: beforeReversal,
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
          causationId: reversalTx.id,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {
            walletId: wallet.id,
            transactionId: reversalTx.id,
            direction: ledgerDirection,
            money: money.toJSON(),
            balanceBefore: beforeReversal.toJSON(),
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
        aggregateId: reversalTx.id,
        eventType: 'WagerTransactionProcessed',
        payload: {
          eventId: randomUUID(),
          eventType: 'WagerTransactionProcessed',
          aggregateId: reversalTx.id,
          correlationId,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {
            transactionId: reversalTx.id,
            idempotencyKey: reversalTx.idempotencyKey,
            playerId: reversalTx.playerId,
            walletId: wallet.id,
            kind: reversalTx.kind,
            money: money.toJSON(),
            status: 'PROCESSED',
            balance: wallet.balance.toJSON(),
          },
        },
      }),
    );

    await this.recordInboxIfPresent(txEm, cmd, payloadHash);

    return {
      transactionId: reversalTx.id,
      idempotencyKey: reversalTx.idempotencyKey,
      status: 'PROCESSED',
      balance: wallet.balance.toString(),
      currency: wallet.currency,
      idempotentReplay: false,
    };
  }

  private async rejectAndPersist(
    txEm: EntityManager,
    wallet: Wallet,
    cmd: ProcessWagerCommand,
    money: Money,
    provider: string,
    payloadHash: string,
    correlationId: string,
    failureCode: string,
  ): Promise<ProcessWagerResult> {
    const rejectedTx = WagerTransaction.create({
      id: randomUUID(),
      idempotencyKey: cmd.idempotencyKey,
      walletId: wallet.id,
      playerId: cmd.playerId,
      kind: cmd.kind,
      amount: money.toDecimal(),
      currency: money.currency,
      status: 'REJECTED',
      provider,
      externalTransactionId: cmd.externalTransactionId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      referenceTransactionId: cmd.referenceTransactionId,
      payloadHash,
      failureCode,
    });
    txEm.persist(rejectedTx);

    txEm.persist(
      OutboxMessage.create({
        id: randomUUID(),
        aggregateType: 'WagerTransaction',
        aggregateId: rejectedTx.id,
        eventType: 'WagerTransactionRejected',
        payload: {
          eventId: randomUUID(),
          eventType: 'WagerTransactionRejected',
          aggregateId: rejectedTx.id,
          correlationId,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {
            transactionId: rejectedTx.id,
            idempotencyKey: rejectedTx.idempotencyKey,
            playerId: rejectedTx.playerId,
            walletId: wallet.id,
            kind: rejectedTx.kind,
            money: money.toJSON(),
            status: 'REJECTED',
            failureCode,
            balance: wallet.balance.toJSON(),
          },
        },
      }),
    );

    await this.recordInboxIfPresent(txEm, cmd, payloadHash);

    return {
      transactionId: rejectedTx.id,
      idempotencyKey: rejectedTx.idempotencyKey,
      status: 'REJECTED',
      balance: wallet.balance.toString(),
      currency: wallet.currency,
      idempotentReplay: false,
      failureCode,
    };
  }

  private async recordInboxIfPresent(
    txEm: EntityManager,
    cmd: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<void> {
    if (!cmd.inboxContext) return;

    const existingInbox = await txEm.findOne(InboxMessage, {
      consumerName: cmd.inboxContext.consumerName,
      messageId: cmd.inboxContext.messageId,
    });

    if (!existingInbox) {
      txEm.persist(
        InboxMessage.createProcessed({
          id: randomUUID(),
          consumerName: cmd.inboxContext.consumerName,
          messageId: cmd.inboxContext.messageId,
          payloadHash,
        }),
      );
    }
  }

  private computePayloadHash(
    cmd: ProcessWagerCommand,
    money: Money,
    provider: string,
  ): string {
    const canonical = JSON.stringify({
      currency: money.currency,
      externalTransactionId: cmd.externalTransactionId ?? null,
      gameId: cmd.gameId ?? null,
      idempotencyKey: cmd.idempotencyKey,
      kind: cmd.kind,
      money: money.toJSON(),
      playerId: cmd.playerId,
      provider,
      referenceTransactionId: cmd.referenceTransactionId ?? null,
      roundId: cmd.roundId ?? null,
      walletId: cmd.walletId ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }
}
