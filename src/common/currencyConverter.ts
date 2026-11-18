import { Money } from './class/Money.js';

export interface CurrencyConverter {
  convert(amount: Money, targetCurrency: string): Promise<Money>;
}