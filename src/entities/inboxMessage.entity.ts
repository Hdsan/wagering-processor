export type InboxStatus = 'PROCESSED' | 'FAILED';

export interface InboxMessageState {
  id: string;
  consumerName: string;
  messageId: string;
  payloadHash: string;
  status: InboxStatus;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly id: string,
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    private _status: InboxStatus,
    private _attempts: number,
    private _lastError: string | undefined,
    public readonly createdAt: Date,
    private _processedAt?: Date,
  ) {}

  static createProcessed(props: {
    id: string;
    consumerName: string;
    messageId: string;
    payloadHash: string;
    attempts?: number;
  }): InboxMessage {
    if (!props.id || !props.consumerName || !props.messageId || !props.payloadHash) {
      throw new Error('All InboxMessage properties are required.');
    }

    const now = new Date();
    return new InboxMessage(
      props.id,
      props.consumerName,
      props.messageId,
      props.payloadHash,
      'PROCESSED',
      props.attempts ?? 1,
      undefined,
      now,
      now,
    );
  }

  static createFailed(props: {
    id: string;
    consumerName: string;
    messageId: string;
    payloadHash: string;
    attempts: number;
    error: string;
  }): InboxMessage {
    const now = new Date();
    return new InboxMessage(
      props.id,
      props.consumerName,
      props.messageId,
      props.payloadHash,
      'FAILED',
      props.attempts,
      props.error,
      now,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.id,
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.status,
      state.attempts,
      state.lastError,
      state.createdAt,
      state.processedAt,
    );
  }

  get status(): InboxStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markAsProcessed(): void {
    this._status = 'PROCESSED';
    this._lastError = undefined;
    this._processedAt = new Date();
  }

  recordFailure(error: string): void {
    this._attempts += 1;
    this._status = 'FAILED';
    this._lastError = error;
  }
}