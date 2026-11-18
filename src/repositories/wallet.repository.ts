import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../entities/wallet.entity.js';
import { WagerTransaction } from '../entities/wagerTransaction.entity.js';
import { WalletLedgerEntry } from '../entities/walletLedgerEntry.entity.js';

@Injectable()
export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id });
  }

  async findByPlayerId(playerId: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { playerId });
  }

  async findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { idempotencyKey });
  }

  async findLedgerEntryByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    return this.em.findOne(WalletLedgerEntry, { transactionId });
  }

  async saveTransactionOnly(transaction: WagerTransaction): Promise<void> {
    await this.em.transactional(async (txEm) => {
      txEm.persist(transaction);
      await txEm.flush();
    });
  }

  async saveWithLedger(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry?: WalletLedgerEntry,
  ): Promise<void> {
    await this.em.transactional(async (txEm) => {
      txEm.persist(wallet);
      txEm.persist(transaction);
      if (ledgerEntry) {
        txEm.persist(ledgerEntry);
      }
      await txEm.flush();
    });
  }
}