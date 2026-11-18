import { Money } from '../common/class/Money.js';

export type LedgerEntryType = 'CREDIT' | 'DEBIT';

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  type: LedgerEntryType;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly type: LedgerEntryType,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: {
    id: string;
    walletId: string;
    transactionId: string;
    type: LedgerEntryType;
    amount: Money;
    balanceBefore: Money;
  }): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new Error('Ledger entry ID, Wallet ID, and Transaction ID are required.');
    }

    if (props.amount.isNegative() || props.amount.isZero()) {
      throw new Error('Ledger amount must be strictly positive.');
    }

    if (props.balanceBefore.currency !== props.amount.currency) {
      throw new Error('Currency mismatch between balanceBefore and ledger amount.');
    }

    let balanceAfter: Money;

    if (props.type === 'CREDIT') {
      balanceAfter = props.balanceBefore.add(props.amount);
    } else if (props.type === 'DEBIT') {
      if (props.balanceBefore.isLessThan(props.amount)) {
        throw new Error('Ledger invariant violation: debit amount exceeds balanceBefore.');
      }
      balanceAfter = props.balanceBefore.subtract(props.amount);
    } else {
      throw new Error(`Invalid ledger entry type: "${props.type}"`);
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.type,
      props.amount,
      props.balanceBefore,
      balanceAfter,
      new Date(),
    );
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.type,
      state.amount,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }
}