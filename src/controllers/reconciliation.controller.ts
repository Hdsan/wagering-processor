import {
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { Money } from '../common/class/Money.js';
import { Wallet } from '../entities/wallet.entity.js';
import { WalletLedgerEntry } from '../entities/walletLedgerEntry.entity.js';

@Controller('wallets')
export class ReconciliationController {
  private readonly logger = new Logger(ReconciliationController.name);

  constructor(private readonly em: EntityManager) {}

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcileWallet(@Param('walletId') walletId: string) {
    const wallet = await this.em.findOne(Wallet, { id: walletId });
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }

    const entries = await this.em.find(
      WalletLedgerEntry,
      { walletId: wallet.id },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } },
    );

    let calculated = new Decimal(0);
    let chainValid = true;

    for (const entry of entries) {
      const amount = entry.amount.toDecimal();
      const before = entry.balanceBefore.toDecimal();
      const after = entry.balanceAfter.toDecimal();

      if (!before.equals(calculated)) {
        chainValid = false;
      }

      if (entry.type === 'CREDIT') {
        calculated = calculated.plus(amount);
      } else if (entry.type === 'DEBIT') {
        calculated = calculated.minus(amount);
      }

      if (!after.equals(calculated)) {
        chainValid = false;
      }
    }

    const stored = wallet.balance.toDecimal();
    const diff = stored.minus(calculated);
    const consistent = diff.isZero() && chainValid;

    if (!consistent) {
      this.logger.error(
        JSON.stringify({
          event: 'WALLET_RECONCILIATION_DISCREPANCY',
          walletId: wallet.id,
          currency: wallet.currency,
          checkedEntries: entries.length,
          chainValid,
        }),
      );
    }

    return {
      walletId: wallet.id,
      storedBalance: Money.fromDecimal(stored, wallet.currency).toJSON(),
      calculatedBalance: Money.fromDecimal(calculated, wallet.currency).toJSON(),
      difference: {
        amount: diff.toFixed(2),
        currency: wallet.currency,
      },
      consistent,
      checkedEntries: entries.length,
    };
  }
}