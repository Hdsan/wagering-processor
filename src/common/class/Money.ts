import { Decimal } from 'decimal.js';

const STRICT_MONEY_REGEX = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
export interface MoneyProps {
  amount: string;
  currency: string;
}
export class Money {
  private readonly value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    if (!ISO_CURRENCY_REGEX.test(currency)) {
      throw new Error(`Invalid currency code: ${currency}`);
    }
    if (!value.isFinite() || value.isNegative() || value.decimalPlaces() > 2) {
      throw new Error(`Invalid monetary amount: ${value.toString()}`);
    }
    this.value = value;
    this.currency = currency;
  }
  static from(props: MoneyProps): Money {
    return Money.of(props.amount, props.currency);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }
  static of(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !STRICT_MONEY_REGEX.test(amount.trim())) {
      throw new Error(
        `Invalid money string "${String(amount)}". Must be a non-negative decimal string with up to 2 decimal places.`,
      );
    }
    return new Money(new Decimal(amount.trim()), currency.trim().toUpperCase());
  }

  static fromDecimal(amount: Decimal, currency: string): Money {
    return new Money(amount, currency.trim().toUpperCase());
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency.trim().toUpperCase());
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value);
    if (result.isNegative()) {
      throw new Error(
        'Insufficient funds: resulting balance cannot be negative',
      );
    }
    return new Money(result, this.currency);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toDecimal(): Decimal {
    return this.value;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}
