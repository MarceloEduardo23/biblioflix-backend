# BiblioFlix — Backend (Microsserviços)

Backend do sistema de biblioteca **BiblioFlix**, organizado em microsserviços
independentes atrás de um **API Gateway**, conforme a arquitetura do relatório
(seções 6.1–6.3 e 7.3). O frontend (repositório separado `biblioflix-frontend`)
conversa **apenas** com o gateway.

## Arquitetura

```
            ┌────────────────────────┐
  Frontend  │     API Gateway        │  :8000
  (Next.js) │  - valida JWT          │
   ───────► │  - injeta identidade   │
            │  - roteia por prefixo  │
            │  - agrega /health      │
            └───────────┬────────────┘
        ┌────────┬──────┼───────┬──────────────┐
        ▼        ▼      ▼       ▼              ▼
   Auth :8001  Catalog Loan   Fine        Recommendation/
               :8002  :8003   :8004        Notification :8005
        │        │      │       │              │
     auth_db  catalog_db loan_db fine_db      reco_db   (um banco por serviço)
```

Cada serviço:
- tem responsabilidade única e **banco próprio** (database-per-service);
- expõe `GET /health` (usado pela tela administrativa de status, §6.5 / PB18);
- aplica suas próprias regras de negócio (o gateway só roteia e autentica).

Comunicação entre serviços é feita por **HTTP**. Exemplos:
- o **Loan** chama o **Catalog** para reservar/liberar cópias (`reserve-copy`/`release-copy`);
- o **Loan** chama o **Auth** para resolver dados do leitor;
- o **Fine** e o **Recommendation** leem os empréstimos do **Loan** (`/loans/raw`);
- o **Gateway** agrega `/stats` de Catalog + Auth + Loan para montar `/reports`.

## Serviços e principais rotas (via gateway)

| Serviço | Porta | Rotas (prefixo no gateway) |
|---|---|---|
| api-gateway | 8000 | `/health`, `/health/services`, `/reports` |
| auth | 8001 | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/users` |
| catalog | 8002 | `/catalog/books`, `/catalog/categories`, `/catalog/slides` |
| loan | 8003 | `/loans`, `/loans/:id/return`, `/loans/:id/renew`, `/loans/:id/pickup` |
| fine | 8004 | `/fines/user/:id`, `/fines/pay`, `/fines/report` |
| recommendation | 8005 | `/recommendations/user/:id`, `/notifications` |

Autenticação: o `auth` emite um **JWT** (HS256) no corpo do login/registro. O
frontend o envia em `Authorization: Bearer <token>`. O gateway valida o token e
injeta `x-user-id` / `x-user-role` nos headers repassados aos serviços.

## Regras de negócio preservadas do projeto original

- status do empréstimo derivado (`pending` / `active` / `overdue` / `returned`);
- multa de **R$1 por dia** de atraso;
- reserva = empréstimo sem retirada, que **expira em 30 min** (libera a cópia);
- **1 cópia por título** por leitor; **máximo de 3** empréstimos ativos;
- **bloqueio** de novo empréstimo para leitor com **atraso grave**
  (configurável via `GRAVE_OVERDUE_DAYS`, padrão 7 dias).

## Como rodar localmente (Docker Compose)

Pré-requisito: Docker + Docker Compose.

```bash
cp .env.example .env      # ajuste AUTH_SECRET se quiser
docker compose up --build
```

Sobe o Postgres (com 5 bancos lógicos) e os 6 serviços. Quando tudo estiver de
pé, o gateway responde em `http://localhost:8000`.

Teste rápido:
```bash
curl http://localhost:8000/health
curl http://localhost:8000/health/services       # status de todos os serviços
curl http://localhost:8000/catalog/books         # catálogo (público)
```

**Login padrão (semeado automaticamente):**
`admin@biblioflix.com` / `admin123` — troque em produção.

O catálogo já nasce com alguns livros e categorias de exemplo (seed).

## Variáveis de ambiente

| Variável | Onde | Descrição |
|---|---|---|
| `AUTH_SECRET` | gateway, auth | Segredo do JWT — **igual** nos dois. |
| `FRONTEND_ORIGIN` | gateway | Origem liberada no CORS (URL do frontend). |
| `DATABASE_URL` | cada serviço | Conexão do banco daquele serviço. |
| `GRAVE_OVERDUE_DAYS` | loan | Dias de atraso que bloqueiam novo empréstimo (padrão 7). |
| `*_URL` (AUTH_URL, CATALOG_URL, …) | gateway, loan, fine, reco | URLs internas dos serviços. |

## Deploy gratuito (sugestão)

Caminho 100% em planos gratuitos:

1. **Banco — Neon (free):** crie um projeto e, dentro dele, os bancos
   `auth_db`, `catalog_db`, `loan_db`, `fine_db`, `reco_db`. Pegue a connection
   string de cada um.
2. **Backend — Render (free):** suba este repositório no GitHub e use o
   `render.yaml` (Blueprint) como ponto de partida. No painel, preencha:
   - `DATABASE_URL` de cada serviço (as do Neon);
   - `AUTH_SECRET` (o mesmo no gateway e no auth);
   - os `*_URL` do gateway/loan/fine/reco com as URLs públicas dos serviços
     (algo como `https://biblioflix-auth.onrender.com`) — você só conhece essas
     URLs **depois** do primeiro deploy, então ajuste e faça redeploy do gateway.
3. **Frontend — Vercel (free):** no repositório `biblioflix-frontend`, defina
   `NEXT_PUBLIC_API_URL` = URL pública do gateway.
4. No gateway, defina `FRONTEND_ORIGIN` = URL da Vercel.

> ⚠️ **Atenção (free tier):** serviços gratuitos do Render **hibernam** após
> inatividade; a primeira requisição depois disso fica lenta (cold start). Para
> uma apresentação, acesse cada serviço uma vez antes para "acordá-los".

## Limitações conhecidas da v1 (próximos passos)

- **Exemplares físicos (PB08/PB21):** a disponibilidade usa contagem
  (`totalCopies`/`availableCopies`), não exemplares individuais com status. O
  domínio está pronto para evoluir: criar a entidade `Copy` no Catalog e
  vincular o empréstimo a uma cópia específica.
- **Relatório de "livros mais emprestados":** depende de contagem por livro
  cruzando Catalog × Loan; não está exposto entre serviços ainda. O relatório
  atual cobre acervo, usuários e empréstimos consolidados.
- **Fila de reservas:** hoje a reserva segura uma cópia disponível; fila de
  espera quando não há cópia (PB09) é uma evolução natural do Loan Service.
