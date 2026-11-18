import { Module } from '@nestjs/common';
import { WalletRepository } from '../../repositories/wallet.repository.js';
import { ProcessWagerUseCase } from '../../usecases/ProcessWagerUseCase.js';
import { InMemoryCurrencyConverter } from '../../common/inMemoryCurrencyConverter.js';
import { SqsWagerConsumer } from '../../messaging/sqsWager.consumer.js';
import { OutboxPublisherWorker } from '../../workers/outbox-publisher.worker.js';
import { PendingReferenceWorker } from '../../workers/pendingReference.worker.js';
import { ReconciliationController } from '../../controllers/reconciliation.controller.js';
import { TransactionsController } from '../../controllers/transactions.controller.js';
import { WalletsController } from '../../controllers/wallets.controller.js';
import { HealthController } from '../../controllers/health.controller.js';
import { MetricsController, MetricsService } from '../../common/observability/metrics.service.js';

@Module({
  imports: [],
  controllers: [
    WalletsController,
    TransactionsController,
    ReconciliationController,
    HealthController,
    MetricsController,
  ],
  providers: [
    MetricsService,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    WalletRepository,
    ProcessWagerUseCase,
    SqsWagerConsumer,
    {
      provide: 'CurrencyConverter',
      useClass: InMemoryCurrencyConverter,
    },
  ],
  exports: [ProcessWagerUseCase, SqsWagerConsumer],
})
export class WageringModule {}