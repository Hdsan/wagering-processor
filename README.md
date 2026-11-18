# Wagering Processor

Serviço de processamento de apostas e carteiras desenvolvido com NestJS, Bun, PostgreSQL e SQS

## Setup rápido

Pré-requisitos:

- Bun
- Docker

O arquivo .env.example tem as informações do ambiente, só renomeie pra .env que vai estar funcional

Instale as dependências e suba a infraestrutura:

```bash
bun install
bun run infra:up
```

Esse comando inicia PostgreSQL e MiniStack, cria as filas SQS e aplica as migrations

Inicie a aplicação:

```bash
bun run start:dev
```

A API fica disponível em `http://localhost:3000`.

Para parar e remover os containers e volumes da infraestrutura:

```bash
bun run infra:down
```

## Testes

Execute os testes unitários:

```bash
bun run test
```

Para executar a suíte de integração e concorrência com infraestrutura real:

```bash
bun run test:e2e
```

O comando `test:e2e` recria PostgreSQL e MiniStack, aplica as migrations e executa os testes em `test/app.spec.ts`, ele remove os volumes da infraestrutura ao iniciar
