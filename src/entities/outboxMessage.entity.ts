export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface OutboxMessageState {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, any>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateType: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Record<string, any>,
    private _status: OutboxStatus,
    private _attempts: number,
    private _nextAttemptAt: Date,
    public readonly createdAt: Date,
    private _publishedAt?: Date,
  ) {}

  static create(props: {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, any>;
  }): OutboxMessage {
    if (!props.id || !props.aggregateId || !props.eventType) {
      throw new Error('OutboxMessage requires id, aggregateId, and eventType.');
    }

    const now = new Date();
    return new OutboxMessage(
      props.id,
      props.aggregateType,
      props.aggregateId,
      props.eventType,
      props.payload,
      'PENDING',
      0,
      now,
      now,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateType,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.status,
      state.attempts,
      state.nextAttemptAt,
      state.createdAt,
      state.publishedAt,
    );
  }

  get status(): OutboxStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  markAsPublished(): void {
    this._status = 'PUBLISHED';
    this._publishedAt = new Date();
  }

  scheduleRetry(maxAttempts = 5): void {
    this._attempts += 1;
    if (this._attempts >= maxAttempts) {
      this._status = 'FAILED';
      return;
    }
    const backoffMs = Math.min(30_000, 1000 * Math.pow(2, this._attempts));
    this._nextAttemptAt = new Date(Date.now() + backoffMs);
  }
}