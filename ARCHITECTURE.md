# Architecture

## Money and persistence

Money uses `Decimal.js` with a strict decimal-string contract. The database stores
amounts as `NUMERIC(19, 2)`. `number`, floating point and scientific notation are
not accepted. Currency mismatches are domain errors.

## Concurrency

The wallet row is the concurrency unit. Financial operations lock the wallet with
`SELECT ... FOR UPDATE` inside a MikroORM PostgreSQL transaction. Separate wallets
can be processed concurrently. The database also enforces `(playerId, currency)`
uniqueness and `wallets.balance >= 0`.

## Idempotency

The HTTP `Idempotency-Key` and SQS envelope's `idempotencyKey` are authoritative.
The payload hash is SHA-256 over the canonical business payload. Replays return
the original transaction and balance; a key reused for a different payload returns
`IDEMPOTENCY_CONFLICT`.

## Inbox, outbox and delivery

Inbox deduplicates SQS by `(consumerName, messageId)`. Inbox, wallet, ledger,
transaction and outbox writes share one SQL transaction. SQS is acknowledged only
after commit. Outbox events use `FOR UPDATE SKIP LOCKED`, allow concurrent
publishers and remain replay-safe.

## Pending references

`REFUND` and `ROLLBACK` require a reference. Missing references become
`PENDING_REFERENCE` and are retried by a scheduled worker until TTL expiration.
Expired references become `REJECTED` with a machine-readable failure code.

## Failure taxonomy

- `INSUFFICIENT_FUNDS`: BET cannot be funded.
- `INSUFFICIENT_FUNDS_FOR_ROLLBACK`: rollback would make the balance negative.
- `DUPLICATE_REVERSAL`: the same reversal kind was already persisted.
- `REFERENCE_NOT_FOUND_EXPIRED`: reference did not arrive before TTL.
- `ORIGINAL_TRANSACTION_NOT_PROCESSED`: reference exists but is not processed.
- `REFERENCE_MISMATCH`: provider, player, wallet, currency, round, type or amount mismatch.
- `WALLET_NOT_FOUND`: target wallet is absent.

## Authentication

Authentication is intentionally an integration point rather than a local password
system. `/health/*` is public and SQS is a trusted internal channel. `AuthGuard`
is the explicit extension point for an external OIDC/JWT provider.

## Operational limits

Pessimistic wallet locks serialize highly concurrent operations for one wallet.
This favors correctness and avoids lost updates. Outbox and pending-reference
workers are separate in-process workers and can run in multiple instances.
