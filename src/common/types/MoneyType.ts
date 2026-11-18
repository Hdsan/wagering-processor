import { Platform, Type } from '@mikro-orm/core';
import { Decimal } from 'decimal.js';
import { Money } from '../class/Money.js';

export class MoneyType extends Type<Money, string> {
  convertToDatabaseValue(
    value: Money | Decimal | string | undefined,
    _platform?: Platform,
  ): string {
    if (value === undefined || value === null) {
      return '0.00';
    }

    if (value instanceof Money) {
      return value.toString();
    }

    if (value instanceof Decimal) {
      return value.toFixed(2);
    }

    return Money.of(value, 'BRL').toString();
  }

  convertToJSValue(
    value: string | Money | Decimal | undefined,
    _platform?: Platform,
  ): Money {
    if (value === undefined || value === null) {
      return Money.zero('BRL');
    }

    if (value instanceof Money) {
      return value;
    }

    if (value instanceof Decimal) {
      return Money.fromDecimal(value, 'BRL');
    }

    return Money.of(value, 'BRL');
  }

  getColumnType(_prop: unknown, _platform?: Platform): string {
    return 'numeric(19, 2)';
  }
}