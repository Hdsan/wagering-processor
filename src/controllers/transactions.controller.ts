import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money, MoneyProps } from '../common/class/Money.js';
import { ProcessWagerUseCase } from '../usecases/ProcessWagerUseCase.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../entities/wagerTransaction.entity.js';

interface SubmitWagerDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind | 'OPENING';
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
export class TransactionsController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerUseCase,
    private readonly em: EntityManager,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: SubmitWagerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('Header "Idempotency-Key" is required.');
    }

    if (!body?.providerId || !body?.externalTransactionId || !body?.playerId || !body?.kind) {
      throw new BadRequestException(
        'providerId, externalTransactionId, playerId and kind are required.',
      );
    }

    if ((body.kind as string) === 'OPENING') {
      throw new BadRequestException('OPENING is an internal transaction kind and cannot be submitted.');
    }

    if (
      !body.money ||
      typeof body.money !== 'object' ||
      typeof body.money.amount !== 'string' ||
      typeof body.money.currency !== 'string'
    ) {
      throw new BadRequestException('money must be { amount: string, currency: string }.');
    }

    try {
      const result = await this.processWagerUseCase.execute({
        idempotencyKey: idempotencyKey.trim(),
        provider: body.providerId,
        externalTransactionId: body.externalTransactionId,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind as WagerTransactionKind,
        amount: body.money.amount,
        currency: body.money.currency,
        referenceTransactionId: body.referenceExternalTransactionId,
        correlationId,
      });

      const responseBody = {
        transactionId: result.transactionId,
        status: result.status,
        balance: {
          amount: result.balance,
          currency: result.currency,
        },
        idempotentReplay: result.idempotentReplay,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };

      if (result.status === 'PENDING_REFERENCE') {
        res.status(202);
        return responseBody;
      }

      if (result.status === 'REJECTED') {
        throw new UnprocessableEntityException(responseBody);
      }

      res.status(200);
      return responseBody;
    } catch (err: any) {
      if (err instanceof UnprocessableEntityException) {
        throw err;
      }
      if (err.message?.startsWith('IDEMPOTENCY_CONFLICT')) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: err.message,
        });
      }
      if (
        err.message?.startsWith('VALIDATION_ERROR') ||
        err.message?.startsWith('UNSUPPORTED_KIND') ||
        err.message?.includes('Invalid money') ||
        err.message?.includes('Invalid currency') ||
        err.message?.includes('Currency mismatch')
      ) {
        throw new BadRequestException({
          code: 'INVALID_PAYLOAD',
          message: err.message,
        });
      }
      throw err;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async getByTransactionId(@Param('transactionId') transactionId: string) {
    const tx = await this.em.findOne(WagerTransaction, { id: transactionId });
    if (!tx) {
      throw new NotFoundException(`Transaction "${transactionId}" not found.`);
    }
    return this.serializeTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.em.findOne(WagerTransaction, {
      provider: providerId,
      externalTransactionId,
    });
    if (!tx) {
      throw new NotFoundException(
        `Transaction "${externalTransactionId}" for provider "${providerId}" not found.`,
      );
    }
    return this.serializeTransaction(tx);
  }

  private serializeTransaction(tx: WagerTransaction) {
    return {
      transactionId: tx.id,
      idempotencyKey: tx.idempotencyKey,
      providerId: tx.provider,
      externalTransactionId: tx.externalTransactionId ?? null,
      playerId: tx.playerId,
      walletId: tx.walletId ?? null,
      roundId: tx.roundId ?? null,
      gameId: tx.gameId ?? null,
      kind: tx.kind,
      money: Money.fromDecimal(tx.amount, tx.currency).toJSON(),
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
    };
  }
}