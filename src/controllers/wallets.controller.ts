import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { Money, MoneyProps } from '../common/class/Money.js';
import { Wallet } from '../entities/wallet.entity.js';
import { WalletLedgerEntry } from '../entities/walletLedgerEntry.entity.js';
import { WagerTransaction } from '../entities/wagerTransaction.entity.js';

interface LedgerCursor {
  createdAt: string;
  id: string;
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly em: EntityManager) {}

  @Post()
  async createWallet(
    @Body() body: { playerId: string; initialBalance: MoneyProps },
  ) {
    if (!body?.playerId || typeof body.playerId !== 'string') {
      throw new BadRequestException('playerId is required.');
    }

    if (
      !body?.initialBalance ||
      typeof body.initialBalance !== 'object' ||
      typeof body.initialBalance.amount !== 'string' ||
      typeof body.initialBalance.currency !== 'string'
    ) {
      throw new BadRequestException(
        'initialBalance must be an object { amount: string, currency: string }.',
      );
    }

    let initialMoney: Money;
    try {
      initialMoney = Money.from(body.initialBalance);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    return this.em.transactional(async (txEm) => {
      const existing = await txEm.findOne(Wallet, {
        playerId: body.playerId,
        currency: initialMoney.currency,
      });

      if (existing) {
        throw new ConflictException(
          `Wallet already exists for player "${body.playerId}" in ${initialMoney.currency}.`,
        );
      }

      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: body.playerId,
        initialBalance: initialMoney,
      });
      txEm.persist(wallet);

      if (initialMoney.isPositive()) {
        const openingTxId = randomUUID();
        const idempotencyKey = `opening:${wallet.id}`;
        const payloadHash = createHash('sha256')
          .update(
            JSON.stringify({
              walletId: wallet.id,
              playerId: wallet.playerId,
              amount: initialMoney.toString(),
              currency: initialMoney.currency,
              kind: 'OPENING',
            }),
          )
          .digest('hex');

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          idempotencyKey,
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'OPENING' as any,
          amount: initialMoney.toDecimal(),
          currency: initialMoney.currency,
          status: 'PROCESSED',
          provider: 'internal',
          externalTransactionId: openingTxId,
          roundId: 'opening',
          gameId: 'system',
          payloadHash,
        });
        txEm.persist(openingTx);

        const ledgerEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: openingTxId,
          type: 'CREDIT',
          amount: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
        });
        txEm.persist(ledgerEntry);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    const wallet = await this.em.findOne(Wallet, { id: walletId });
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId/ledger')
  async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const wallet = await this.em.findOne(Wallet, { id: walletId });
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }

    const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : 50;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;

    const qb = this.em
      .createQueryBuilder(WalletLedgerEntry, 'le')
      .select('*')
      .where({ walletId });

    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      const cursorDate = new Date(decoded.createdAt);
      qb.andWhere(
        '(le.created_at < ? OR (le.created_at = ? AND le.id < ?))',
        [cursorDate, cursorDate, decoded.id],
      );
    }

    const rows = await qb
      .orderBy({ createdAt: 'DESC', id: 'DESC' })
      .limit(limit + 1)
      .getResultList();

    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const lastItem = items[items.length - 1];

    return {
      walletId: wallet.id,
      items: items.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.type,
        money: Money.fromDecimal(entry.amount.toDecimal(), wallet.currency).toJSON(),
        balanceBefore: Money.fromDecimal(entry.balanceBefore.toDecimal(), wallet.currency).toJSON(),
        balanceAfter: Money.fromDecimal(entry.balanceAfter.toDecimal(), wallet.currency).toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasNextPage && lastItem ? this.encodeCursor(lastItem) : null,
      hasNextPage,
    };
  }

  private encodeCursor(entry: WalletLedgerEntry): string {
    const payload: LedgerCursor = {
      createdAt: entry.createdAt.toISOString(),
      id: entry.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): LedgerCursor {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as LedgerCursor;
      if (!parsed.createdAt || !parsed.id) {
        throw new Error('Invalid cursor');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid pagination cursor.');
    }
  }
}