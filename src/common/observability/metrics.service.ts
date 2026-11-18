import { Controller, Get, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../entities/outboxMessage.entity.js';

@Injectable()
export class MetricsService {
  private readonly txByStatus: Record<string, number> = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };
  private duplicatesDetected = 0;
  private retries = 0;
  private dlqMessages = 0;
  private lockOrIdempotencyConflicts = 0;
  private reconciliationDiscrepancies = 0;
  private readonly latenciesMs: number[] = [];

  recordTransaction(status: string, durationMs: number, idempotentReplay = false) {
    if (idempotentReplay) {
      this.duplicatesDetected += 1;
    } else {
      this.txByStatus[status] = (this.txByStatus[status] ?? 0) + 1;
    }
    this.latenciesMs.push(durationMs);
    if (this.latenciesMs.length > 1000) {
      this.latenciesMs.shift();
    }
  }

  recordDuplicate() {
    this.duplicatesDetected += 1;
  }

  recordRetry() {
    this.retries += 1;
  }

  recordDlq() {
    this.dlqMessages += 1;
  }

  recordConflict() {
    this.lockOrIdempotencyConflicts += 1;
  }

  recordReconciliationDiscrepancy() {
    this.reconciliationDiscrepancies += 1;
  }

  snapshot() {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;

    return {
      transactionsByStatus: { ...this.txByStatus },
      duplicatesDetected: this.duplicatesDetected,
      retries: this.retries,
      dlqMessages: this.dlqMessages,
      conflicts: this.lockOrIdempotencyConflicts,
      reconciliationDiscrepancies: this.reconciliationDiscrepancies,
      latencyMs: {
        samples: sorted.length,
        p50: Number(p50.toFixed(2)),
        p95: Number(p95.toFixed(2)),
        p99: Number(p99.toFixed(2)),
      },
    };
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly em: EntityManager,
  ) {}

  @Get()
  async getMetrics() {
    const pendingOutboxCount = await this.em.count(OutboxMessage, {
      _status: { $in: ['PENDING', 'FAILED'] },
    } as any);

    const oldestPending = await this.em.findOne(
      OutboxMessage,
      { _status: { $in: ['PENDING', 'FAILED'] } } as any,
      { orderBy: { createdAt: 'ASC' } },
    );

    const outboxLagSeconds = oldestPending
      ? Number(((Date.now() - oldestPending.createdAt.getTime()) / 1000).toFixed(2))
      : 0;

    return {
      timestamp: new Date().toISOString(),
      outbox: {
        pendingEvents: pendingOutboxCount,
        lagSeconds: outboxLagSeconds,
      },
      ...this.metrics.snapshot(),
    };
  }
}