import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';

export type WagerTransactionKind =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export type WagerTransactionStatus =
  | 'PENDING'
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'FAILED';

export class WagerTransaction {
  id: string = randomUUID();
  idempotencyKey!: string;
  walletId?: string;
  playerId!: string;
  kind!: WagerTransactionKind;
  amount!: Decimal;
  currency!: string;

  private _status: WagerTransactionStatus = 'PENDING';
  get status(): WagerTransactionStatus {
    return this._status;
  }
  provider: string = 'default';
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  referenceTransactionId?: string;
  payloadHash!: string;

  private _failureCode?: string;
  get failureCode(): string | undefined {
    return this._failureCode;
  }
  set failureCode(value: string | undefined) {
    this._failureCode = value;
  }

  createdAt: Date = new Date();

  private _updatedAt: Date = new Date();
  get updatedAt(): Date {
    return this._updatedAt;
  }
  set updatedAt(value: Date) {
    this._updatedAt = value;
  }

  private constructor(props?: Partial<WagerTransaction>) {
    if (!props) return;
    const writableProps = { ...props } as Record<string, unknown>;
    delete writableProps.status;
    delete writableProps.failureCode;
    delete writableProps.updatedAt;
    delete writableProps.processedAt;
    Object.assign(this, writableProps);
    if (!this._status) this._status = 'PENDING';
    if (!this._updatedAt) {
      this._updatedAt = new Date();
    }
  }

  static create(props: Partial<WagerTransaction> & {
    idempotencyKey: string;
    playerId: string;
    kind: WagerTransactionKind;
    status?: WagerTransactionStatus;
  }): WagerTransaction {
    if (!props.idempotencyKey || !props.playerId || !props.kind) {
      throw new Error('VALIDATION_ERROR: idempotencyKey, playerId and kind are required.');
    }
    if (props.kind === 'OPENING' && props.provider !== 'internal') {
      throw new Error('VALIDATION_ERROR: OPENING is an internal operation.');
    }
    if (
      (props.kind === 'REFUND' || props.kind === 'ROLLBACK') &&
      !props.referenceTransactionId
    ) {
      throw new Error('VALIDATION_ERROR: referenceTransactionId is required.');
    }
    const tx = new WagerTransaction(props);
    tx._status = props.status ?? 'PENDING';
    if (props.failureCode) tx._failureCode = props.failureCode;
    return tx;
  }

  static rehydrate(props: Partial<WagerTransaction>): WagerTransaction {
    const tx = new WagerTransaction(props);
    tx._status = props.status ?? 'PENDING';
    if (props.failureCode) tx._failureCode = props.failureCode;
    return tx;
  }

markProcessed(processedAt: Date = new Date(), referenceTransactionId?: string): void {
  if (this._status === 'REJECTED' || this._status === 'FAILED') {
    throw new Error(
      `INVALID_STATE_TRANSITION: cannot mark ${this._status} transaction as PROCESSED.`,
    );
  }

  if (referenceTransactionId !== undefined) {
    this.referenceTransactionId = referenceTransactionId;
  }

  this._status = 'PROCESSED';
  this._updatedAt = processedAt;
}

  markPendingReference(at: Date = new Date(), referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = 'PENDING_REFERENCE';
    this.referenceTransactionId = referenceTransactionId;
    this._updatedAt = at;
  }

  reject(failureCode: string, at: Date = new Date(), referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = 'REJECTED';
    this._failureCode = failureCode;
    this.referenceTransactionId = referenceTransactionId;
    this._updatedAt = at;
  }

  fail(failureCode: string, at: Date = new Date(), referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = 'FAILED';
    this._failureCode = failureCode;
    this.referenceTransactionId = referenceTransactionId;
    this._updatedAt = at;
  }

  private assertNotTerminal(): void {
    if (
      this._status === 'PROCESSED' ||
      this._status === 'REJECTED' ||
      this._status === 'FAILED'
    ) {
      throw new Error(`InvalidTransactionStateError: ${this._status}`);
    }
  }
}