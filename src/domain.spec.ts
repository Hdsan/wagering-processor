import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { Money } from './common/class/Money.js';
import { Wallet } from './entities/wallet.entity.js';
import { WalletLedgerEntry } from './entities/walletLedgerEntry.entity.js';
import { WagerTransaction } from './entities/wagerTransaction.entity.js';

describe('Money', () => {
  it('uses exact decimal strings and rejects invalid input', () => {
    expect(() => Money.of(10 as any, 'BRL')).toThrow();
    expect(() => Money.of('-1.00', 'BRL')).toThrow();
    expect(() => Money.of('1.001', 'BRL')).toThrow();
    expect(() => Money.of('NaN', 'BRL')).toThrow();
    expect(Money.of('25', 'BRL').toString()).toBe('25.00');
  });

  it('rejects operations across currencies', () => {
    const brl = Money.of('10.00', 'BRL');
    const usd = Money.of('10.00', 'USD');
    expect(() => brl.add(usd)).toThrow(/Currency mismatch/);
  });

  it('keeps arithmetic immutable', () => {
    const initial = Money.of('100.00', 'BRL');
    const debited = initial.subtract(Money.of('30.00', 'BRL'));
    expect(initial.toString()).toBe('100.00');
    expect(debited.toString()).toBe('70.00');
  });
});

describe('Wallet and ledger', () => {
  it('increments version only when a balance changes', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.of('100.00', 'BRL'),
    });
    expect(wallet.version).toBe(1);
    wallet.debit(Money.of('30.00', 'BRL'));
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toString()).toBe('70.00');
  });

  it('rejects insufficient funds and currency mismatches', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });
    expect(() => wallet.debit(Money.of('1.00', 'BRL'))).toThrow();
    expect(() => wallet.credit(Money.of('1.00', 'USD'))).toThrow();
  });

  it('creates a balanced immutable ledger entry', () => {
    const before = Money.of('100.00', 'BRL');
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      type: 'DEBIT',
      amount: Money.of('30.00', 'BRL'),
      balanceBefore: before,
    });
    expect(entry.balanceAfter.toString()).toBe('70.00');
  });
});

describe('WagerTransaction transitions', () => {
  it('starts pending and protects terminal states', () => {
    const tx = WagerTransaction.create({
      id: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      kind: 'BET',
      amount: new Decimal('25.00'),
      currency: 'BRL',
      provider: 'provider-a',
      payloadHash: 'hash',
    });
    expect(tx.status).toBe('PENDING');
    tx.markProcessed();
    expect(tx.status).toBe('PROCESSED');
    expect(() => tx.reject('INSUFFICIENT_FUNDS')).toThrow(/InvalidTransactionStateError/);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create({
        idempotencyKey: 'provider-a:refund-1',
        playerId: 'player-1',
        kind: 'REFUND',
      }),
    ).toThrow(/referenceTransactionId/);
  });
});
