import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(private readonly em: EntityManager) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });
    this.queueUrl =
      process.env.SQS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  @Get('live')
  liveness() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async readiness() {
    const checks: Record<string, { status: 'up' | 'down'; error?: string }> = {
      postgres: { status: 'down' },
      sqs: { status: 'down' },
    };

    try {
      await this.em.getConnection().execute('SELECT 1');
      checks.postgres = { status: 'up' };
    } catch (err: any) {
      checks.postgres = { status: 'down', error: err.message };
    }

    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      checks.sqs = { status: 'up' };
    } catch (err: any) {
      checks.sqs = { status: 'down', error: err.message };
    }

    const allUp = checks.postgres.status === 'up' && checks.sqs.status === 'up';
    const payload = {
      status: allUp ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };

    if (!allUp) {
      throw new ServiceUnavailableException(payload);
    }

    return payload;
  }
}