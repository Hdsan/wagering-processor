# Arquitetura e Decisões Técnicas — Distributed Wagering Processor

## Setup rápido

```bash
bun install
bun run infra:up
bun run build
bun run start
```

`infra:up` aguarda PostgreSQL e MiniStack, cria as filas e aplica as migrations.
PostgreSQL fica em `localhost:5433` e o MiniStack em `localhost:4566`.

## Comandos

```bash
bun run build
bun run test
bun run test:unit
bun run test:e2e
bun run lint
bun run infra:down
```

`test:e2e` recria PostgreSQL e MiniStack com dados temporários e executa integrações reais.

## 1. Visão Geral
Serviço financeiro distribuído para processamento de apostas e carteiras digitais construído com **Bun**, **NestJS**, **MikroORM**, **PostgreSQL** e **AWS SQS** (via MiniStack). O projeto segue **Domain-Driven Design (DDD)** para isolar regras financeiras e invariantes de estado de detalhes de transporte (HTTP e mensageria).

## 2. Precisão Monetária e Mapeamento ORM
* **Value Object `Money`:** Imutável, respaldado por `decimal.js`, exigindo strings decimais estritas (`^(0|[1-9]\d*)(\.\d{1,2})?$`) e rejeitando `number`, `NaN`, `Infinity`, notação científica e operações entre moedas divergentes.
* **Persistência (`MoneyType`):** Mapeado no PostgreSQL como `NUMERIC(19, 2)`, preservando exatidão decimal sem arredondamento binário.
* **Invariante no Banco:** A tabela `wallets` possui `CHECK (balance >= 0)` para garantir que nenhuma falha de aplicação viole a não-negatividade do saldo.

## 3. Estratégia Transacional e Controle de Concorrência
* **Unidade de Concorrência (`walletId` / `(playerId, currency)`):**
  * **Lock Pessimista (`LockMode.PESSIMISTIC_WRITE` / `SELECT ... FOR UPDATE`):** Adquirido na linha da `Wallet` dentro de `em.transactional()`. Isso serializa rajadas concorrentes sobre a mesma carteira (evitando *lost updates* e corrida de saldo) enquanto permite que carteiras de jogadores distintos rodem em paralelo sem lock global.
  * **Lock Otimista (`version`):** Mapeado com `version: true` no `WalletSchema` como segunda barreira de integridade.
* **Ledger Imutável (`wallet_ledger_entries`):** Cada movimentação aprovada grava `balanceBefore` e `balanceAfter`, validando `balanceBefore ± amount === balanceAfter` na factory `WalletLedgerEntry.create`. O endpoint `POST /wallets/:walletId/reconciliation` verifica toda a cadeia sem mascarar divergências.

## 4. Idempotência e Hash Canônico
* **Fontes de Unicidade no Schema:** Índices únicos em `idempotency_key` e `(provider, external_transaction_id)`.
* **Algoritmo de `payloadHash`:** Serialização JSON canônica (chaves de negócio ordenadas alfabeticamente: `currency`, `externalTransactionId`, `gameId`, `idempotencyKey`, `kind`, `money`, `playerId`, `provider`, `referenceTransactionId`, `roundId`, `walletId`) seguida de `SHA-256`. Metadados de transporte não afetam o hash.
* **Semântica:**
  * Mesmo `Idempotency-Key` + mesmo `payloadHash` → `200 OK` com resultado original e `idempotentReplay: true`.
  * Mesmo `Idempotency-Key` + `payloadHash` divergente → `409 Conflict` (`IDEMPOTENCY_CONFLICT`).

## 5. Reversões Fora de Ordem e Taxonomia de `failureCode`
* **Entrega Fora de Ordem:** Quando `REFUND` ou `ROLLBACK` chega antes da transação referenciada, é gravado em `PENDING_REFERENCE` (HTTP `202`). Pode ser liquidado imediatamente caso a aposta original chegue em seguida, ou reprocessado pelo `PendingReferenceWorker` com backoff exponencial até o TTL (`PENDING_REF_TTL_MS`, padrão 5 min), quando então expira como `REJECTED` (`REFERENCE_NOT_FOUND_EXPIRED`).
* **Taxonomia de `failureCode`:**
  * `INSUFFICIENT_FUNDS`: Saldo insuficiente para `BET` (não retentável sem novo depósito).
  * `INSUFFICIENT_FUNDS_FOR_ROLLBACK`: `ROLLBACK` de crédito (`WIN`/`REFUND`) deixaria a carteira negativa (distinto de aposta sem saldo).
  * `DUPLICATE_REVERSAL`: Tentativa de reverter uma referência já revertida pelo mesmo tipo de operação.
  * `ORIGINAL_TRANSACTION_NOT_PROCESSED`: Referência existe, mas está `REJECTED`/`FAILED`/`PENDING`.
  * `REFERENCE_MISMATCH`: Divergência de moeda, rodada, valor ou tipo alvo (`REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou `REFUND`).
  * `REFERENCE_NOT_FOUND_EXPIRED`: Referência não recebida dentro do TTL.

## 6. Mensageria Resiliente (Transactional Inbox / Outbox)
* **Atomicidade:** `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage` (quando via SQS) e `OutboxMessage` são persistidos na **mesma transação SQL**.
* **Ack Pós-Commit:** O `SqsWagerConsumer` executa `DeleteMessage` somente após o commit no PostgreSQL. Erros de negócio recebem ack terminal; falhas transitórias aplicam backoff via `ChangeMessageVisibility`; mensagens malformadas ou que atingem `SQS_MAX_ATTEMPTS` seguem para `wager-transactions-dlq.fifo`.
* **Outbox Concorrente:** O publisher usa `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) para escalar horizontalmente entre múltiplas instâncias sem duplicação coordenada.

## 7. Autenticação (Seção 2)
* Conforme especificado na Seção 2, endpoints `/health/*` são públicos e mensagens SQS trafegam em canal interno confiável. Para os endpoints HTTP de negócio, foi incluído o ponto de extensão explícito `AuthGuard` (`src/common/guards/auth.guard.ts`), preparado para validação de tokens JWT/OIDC emitidos por um Identity Provider externo (Keycloak ou Zitadel) via JWKS.

## 8. Limitações Conhecidas e Trade-offs
* **Lock pessimista em hot wallets:** Garante consistência forte e zero retries de conflito na aplicação, ao custo de serializar transações da mesma carteira durante picos extremos em um único jogador.
* **Reversão parcial fora de escopo:** Conforme Seção 7, `REFUND` e `ROLLBACK` exigem valor idêntico ao da transação referenciada.