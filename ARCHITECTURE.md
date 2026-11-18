#  Wagering Processor

## 1. Visão Geral e Estilo Arquitetural

Este projeto foi desenhado segundo **Domain-Driven Design (DDD)** e **Arquitetura Orientada a Eventos (EDA)** para garantir **correção financeira estrita**, **consistência sob alta concorrência** e **tolerância a falhas** em ambiente multi-instância.

A arquitetura separa claramente:
- **Camada de Domínio (`src/entities`, `src/common/class`)**: Encapsula regras de negócio, máquinas de estado e invariantes financeiras sem dependência de frameworks HTTP ou detalhes de mensageria.
- **Camada de Aplicação (`src/usecases`)**: Orquestra transações ACID, locks de banco, idempotência e emissão de eventos de integração através de um único caso de uso (`ProcessWagerUseCase`) compartilhado entre as entradas HTTP e SQS.
- **Camada de Infraestrutura e Transporte (`src/controllers`, `src/workers`, `src/consumers`, `src/database`)**: Gerencia adaptadores REST, consumo e publicação resiliente via AWS SQS (MiniStack), observabilidade e persistência PostgreSQL via MikroORM.

---

## 2. Decisões de Stack e ORM

### Escolha do MikroORM
O **MikroORM** foi adotado como ORM principal pelos seguintes motivos técnicos:
1. **Unit of Work e Identity Map explícitos:** Garante que múltiplas referências à mesma entidade dentro de um contexto transacional apontem para a mesma instância em memória e sejam persistidas em um único `flush` atômico.
2. **Controle transacional granular (`em.transactional()`):** Isola perfeitamente o escopo de cada operação financeira e permite combinar mutações de saldo, gravação de ledger, deduplicação de inbox e enfileiramento de outbox na mesma transação SQL.
3. **Suporte nativo a modos de lock do PostgreSQL (`LockMode`):** Permite aplicar `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) na carteira e `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) nos workers de fila e outbox.

### Mapeamento e Precisão Monetária (`Money` + `MoneyType`)
- **Domínio (`Money`):** Value Object imutável respaldado por `decimal.js` com escala fixa de 2 casas decimais e arredondamento `ROUND_HALF_UP`. Toda operação (`add`, `subtract`) retorna uma nova instância e valida a igualdade da moeda ISO-4217. Entradas do tipo `number`, `NaN`, `Infinity`, notação científica ou strings com mais de 2 casas decimais são rejeitadas na borda.
- **Persistência (`MoneyType`):** Custom Type do MikroORM que serializa o valor como `NUMERIC(19, 2)` no PostgreSQL e o reidrata diretamente como `Decimal` / `Money`, eliminando qualquer conversão para ponto flutuante binário (`float`/`double`).

---

## 3. Modelo de Domínio e Encapsulamento

Todas as entidades seguem a regra de **construtor protegido/privado** combinado com **factories estáticas** (`create`, `open`, `rehydrate`):

- **`Wallet` (Aggregate Root):**
  - Centraliza as operações `credit()` e `debit()`, garantindo que o saldo nunca fique negativo e que a moeda da operação coincida com a da carteira.
  - Mantém o controle de versão (`version`), incrementado exclusivamente quando há mutação efetiva de saldo.
- **`WagerTransaction` (Máquina de Estados):**
  - Nasce validada via `WagerTransaction.create()` e transiciona apenas por métodos explícitos (`markProcessed`, `markPendingReference`, `reject`, `fail`).
  - `PROCESSED`, `REJECTED` e `FAILED` são estados **terminais**: qualquer tentativa de transição posterior lança erro de domínio (`INVALID_STATE_TRANSITION`), protegendo a trilha de auditoria e preservando o `referenceTransactionId` original.
  - Operações `OPENING` são bloqueadas nas entradas externas (HTTP/SQS), sendo geradas exclusivamente na abertura de carteira com saldo inicial maior que zero.
- **`WalletLedgerEntry` (Imutabilidade Estrutural):**
  - Construído sem métodos de mutação ou setters. A factory `WalletLedgerEntry.create()` valida a equação contábil `balanceBefore ± amount === balanceAfter` antes de permitir a instanciação.
  - Operações sem impacto financeiro (`LOSS` e qualquer transação `REJECTED`) não geram entradas no ledger.

---

## 4. Estratégia Transacional e Controle de Concorrência

A **unidade de concorrência** do sistema é a `walletId` (ou o par `(playerId, currency)`).

### Lock Pessimista (`SELECT ... FOR UPDATE`)
Dentro de `em.transactional()`, a leitura da `Wallet` utiliza `LockMode.PESSIMISTIC_WRITE`.
- **Por que Lock Pessimista em vez de apenas Optimistic Locking?** Em cenários de *hot wallet* (ex.: rajadas de apostas paralelas ou 50 requisições simultâneas na mesma carteira), o lock otimista puro geraria dezenas de exceções de conflito (`OptimisticLockError`) e retries em cascata na aplicação. Com `FOR UPDATE` na linha da carteira, o PostgreSQL serializa as operações daquela carteira específica de forma determinística enquanto carteiras de outros jogadores operam em paralelo sem lock global.
- **Defesa em Profundidade no Schema:** A tabela `wallets` aplica `CHECK (balance >= 0)` e `UNIQUE (player_id, currency)`, garantindo que nenhuma falha lógica viole a não-negatividade ou duplique carteiras.

---

## 5. Idempotência Persistente e Replay Determinístico

Para garantir processamento *exactly-once* efetivo sobre entregas *at-least-once*:

1. **Fontes de Unicidade no PostgreSQL:**
   - Índice único em `wager_transactions(idempotency_key)`.
   - Índice parcial único em `wager_transactions(provider, external_transaction_id)`.
   - Índice parcial único `uq_wager_tx_active_reversal` em `(reference_transaction_id, kind)` para status ativos (`PROCESSED`, `PENDING_REFERENCE`), impedindo reversões duplicadas mesmo sob corrida.
2. **Algoritmo de `payloadHash` Canônico:**
   - Antes de iniciar o processamento, os campos de negócio (`currency`, `externalTransactionId`, `gameId`, `idempotencyKey`, `kind`, `money`, `playerId`, `provider`, `referenceTransactionId`, `roundId`, `walletId`) são ordenados alfabeticamente, serializados em JSON e submetidos a `SHA-256`. Metadados de transporte não alteram o hash.
3. **Semântica de Replay:**
   - **Mesma chave + mesmo `payloadHash`:** Retorna `200 OK` com `idempotentReplay: true` e o **saldo histórico observado no momento da transação original** (recuperado via `WalletLedgerEntry.balanceAfter`), mesmo que apostas posteriores tenham alterado o saldo atual da carteira.
   - **Mesma chave + `payloadHash` divergente:** Retorna `409 Conflict` (`IDEMPOTENCY_CONFLICT`) e incrementa a métrica de conflitos.
   - **Colisão simultânea (`23505`):** Caso duas requisições idênticas ultrapassem a leitura inicial ao mesmo tempo, a constraint única do banco rejeita a segunda, que captura a exceção e executa o fluxo de replay seguro.

---

## 6. Reversões Fora de Ordem (`PENDING_REFERENCE`) e Taxonomia de Erros

### Resolução em Duas Fases
Quando um `REFUND` ou `ROLLBACK` chega antes da transação referenciada:
1. **Persistência Pendente:** A operação é gravada com status `PENDING_REFERENCE` (HTTP `202 Accepted`) e emite `WagerTransactionPendingReference` no Outbox sem alterar o saldo.
2. **Liquidação Reativa ou Agendada:**
   - **Reativa (Síncrona):** Assim que a `BET` correspondente é processada, o `ProcessWagerUseCase` verifica na mesma transação se existe reversão pendente compatível (validando moeda e valor exato), liquida o crédito no saldo, grava o ledger e marca a reversão como `PROCESSED`.
   - **Agendada (`PendingReferenceWorker`):** Worker em background com *backoff exponencial* (`PENDING_REF_BACKOFF_MS`) até o TTL configurado (`PENDING_REF_TTL_MS`, padrão 5 minutos). Esgotado o prazo sem chegada da referência, transiciona para `REJECTED` com `REFERENCE_NOT_FOUND_EXPIRED`.

### Taxonomia de `failureCode` e Mapeamento HTTP
| `failureCode` | HTTP Status | Significado Operacional |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `422 Unprocessable Entity` | Saldo insuficiente para efetivar `BET` (não retentável sem depósito). |
| `INSUFFICIENT_FUNDS_FOR_ROLLBACK` | `422 Unprocessable Entity` | `ROLLBACK` de um `WIN` ou `REFUND` deixaria a carteira negativa (distinto de aposta sem saldo). |
| `DUPLICATE_REVERSAL` | `422 Unprocessable Entity` | Referência já revertida anteriormente pelo mesmo `kind`. |
| `ORIGINAL_TRANSACTION_NOT_PROCESSED` | `422 Unprocessable Entity` | Transação original existe, mas está `REJECTED`, `FAILED` ou `PENDING`. |
| `REFERENCE_MISMATCH` | `422 Unprocessable Entity` | Divergência de moeda, valor, `roundId` ou tipo alvo (`REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou `REFUND`). |
| `REFERENCE_NOT_FOUND_EXPIRED` | `422 Unprocessable Entity` | Referência não recebida dentro do TTL do `PendingReferenceWorker`. |
| `IDEMPOTENCY_CONFLICT` | `409 Conflict` | `Idempotency-Key` reutilizada com payload divergente. |

---

## 7. Mensageria Resiliente: Transactional Inbox / Outbox

### Atomicidade Financeira e de Eventos
Na mesma transação SQL do PostgreSQL são persistidos:
1. Atualização de saldo na `Wallet`;
2. Registro da `WagerTransaction`;
3. Lançamento imutável em `WalletLedgerEntry` (quando há movimento de saldo);
4. Registro de deduplicação em `InboxMessage` por `(consumerName, messageId)` (quando oriundo do SQS);
5. Evento de domínio serializado em `OutboxMessage`.

### Resiliência a Falhas e Múltiplas Instâncias
- **Consumo SQS (`SqsWagerConsumer`):** O comando `DeleteMessage` (ACK) só é enviado ao SQS **após o commit** no PostgreSQL. Se o processo sofrer crash entre o commit e o ACK, a redelivery do SQS é interceptada pela chave única da `InboxMessage` e pela idempotência da transação, sem duplicar débitos ou créditos. Mensagens malformadas ou que atingem o limite de tentativas são encaminhadas para `wager-transactions-dlq.fifo`. Em `SIGTERM`, o consumidor interrompe o polling e aguarda as mensagens em voo concluírem antes de encerrar.
- **Publicação Concorrente (`OutboxPublisherWorker`):** Utiliza `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) para permitir que múltiplas instâncias publiquem lotes simultaneamente sem disputar as mesmas linhas, enviando para a fila FIFO com `MessageGroupId: aggregateId` e `MessageDeduplicationId: msg.id`. Falhas de rede com o broker agendam *retry* com backoff exponencial.

---

## 8. Autenticação (Decisão da Seção 2)

Conforme diretriz da Seção 2, o timebox foi priorizado na correção financeira, concorrência e resiliência distribuída.
- **Desenho adotado:** Endpoints `/health/live` e `/health/ready` permanecem abertos para probes de orquestração, e mensagens SQS trafegam em canal interno confiável (com validação estrita de `providerId` no domínio).
- **Ponto de extensão:** Foi estruturado o `AuthGuard` (`src/common/guards/auth.guard.ts`) aplicado às rotas HTTP de negócio. Em ambiente de produção, este guard valida tokens **JWT/OIDC** assinados por um Identity Provider externo (**Keycloak** ou **Zitadel**) via endpoint **JWKS**, extraindo claims de escopo e identidade do provedor sem manter tabelas locais de credenciais.

---

## 9. Observabilidade e Reconciliação

- **Logs Estruturados:** Saída em JSON contendo `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, omitindo payloads financeiros completos ou dados sensíveis.
- **Métricas (`GET /metrics` / `MetricsService`):** Contadores em tempo real de transações por status, duplicatas/replays detectados, conflitos de idempotência/lock, retries de workers, mensagens enviadas à DLQ, discrepâncias de reconciliação, percentis de latência (`p50`, `p95`, `p99`) e lag atual da tabela Outbox (`pendingEvents` e `lagSeconds`).
- **Reconciliação (`POST /wallets/:walletId/reconciliation`):** Recalcula o saldo integralmente a partir da cadeia ordenada de `WalletLedgerEntry` e compara com `Wallet.balance`. Divergências nunca são corrigidas silenciosamente: são registradas em log, contabilizadas em métrica (`recordReconciliationDiscrepancy`) e expostas explicitamente na resposta.

---

## 10. Limitações Conhecidas e Trade-offs

1. **Contenção em *Hot Wallets*:** O uso de `SELECT ... FOR UPDATE` garante consistência forte e elimina erros de concorrência na camada de aplicação, mas serializa transações destinadas à mesma carteira durante picos extremos de um único jogador.
2. **Reversões Parciais:** Conforme especificado na Seção 7, `REFUND` e `ROLLBACK` exigem valor idêntico ao da transação original; estornos parciais são rejeitados por regra de domínio.
3. **Deduplicação do Broker como Otimização:** Embora filas `.fifo` e `MessageDeduplicationId` reduzam entregas duplicadas no SQS, a garantia definitiva de consistência reside nas constraints únicas e transações ACID do PostgreSQL.