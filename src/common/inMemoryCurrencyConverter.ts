import { Injectable } from '@nestjs/common';
import { Money } from './class/Money.js';
import type { CurrencyConverter } from './currencyConverter.js';

@Injectable()
export class InMemoryCurrencyConverter implements CurrencyConverter {
  async convert(amount: Money, targetCurrency: string): Promise<Money> {
    if (amount.currency === targetCurrency) {
      return amount;
    }
    return Money.of(amount.toString(), targetCurrency);
  }
}