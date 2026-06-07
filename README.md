# BiblioFlix — Backend

API de uma biblioteca digital, organizada em microsserviços independentes atrás
de um API Gateway. Cada serviço tem responsabilidade única e banco de dados
próprio (*database-per-service*); o frontend conversa exclusivamente com o
gateway.

## Sumário

- [Arquitetura](#arquitetura)
- [Serviços e rotas](#serviços-e-rotas)
- [Tecnologias](#tecnologias)
- [Execução local](#execução-local-docker-compose)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Regras de negócio](#regras-de-negócio)
- [Deploy](#deploy)
- [Limitações conhecidas](#limitações-conhecidas)

## Arquitetura

```
                       ┌─────────────────────────┐
   Frontend (Next.js)  │       API Gateway       │  :8000
        ──────────────►│  • valida o JWT         │
                       │  • injeta a identidade  │
                       │  • roteia por prefixo   │
                       │  • agrega /health       │
                       └────────────┬────────────┘
            ┌───────────┬───────────┼───────────┬───────────────┐
            ▼           ▼           ▼           ▼               ▼
        Auth :8001  Catalog    Loan :8003   Fine :8004    Recommendation
                    :8002                                     :8005
            │           │           │           │               │
         auth_db   catalog_db    loan_db     fine_db          reco_db
```

Cada microsserviço:

- mantém um único domínio de negócio e o seu próprio banco lógico, sem tabelas
  compartilhadas;
- expõe `GET /health`, consumido pela tela administrativa de status;
- concentra as próprias regras de negócio — o gateway apenas autentica e roteia.

A comunicação entre serviços é feita por HTTP na rede interna. Por exemplo: o
Loan chama o Catalog para reservar e liberar cópias; o Loan consulta o Auth para
resolver os dados do leitor; Fine e Recommendation leem os empréstimos do Loan;
e o gateway agrega as estatísticas de Catalog, Auth e Loan para montar os
relatórios.

A autenticação usa JWT (HS256), emitido pelo Auth no login e no cadastro. O
frontend o envia em `Authorization: Bearer <token>`. O gateway valida o token e
repassa a identidade aos serviços nos headers `x-user-id` e `x-user-role`.

## Serviços e rotas

Rotas expostas pelo gateway (prefixo entre parênteses):

| Serviço         | Porta | Rotas principais                                                        |
| --------------- | ----- | ----------------------------------------------------------------------- |
| api-gateway     | 8000  | `/health`, `/health/services`, `/reports`                               |
| auth            | 8001  | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/users` |
| catalog         | 8002  | `/catalog/books`, `/catalog/categories`, `/catalog/slides`              |
| loan            | 8003  | `/loans`, `/loans/:id/return`, `/loans/:id/renew`, `/loans/:id/pickup`  |
| fine            | 8004  | `/fines/user/:id`, `/fines/pay`, `/fines/report`                        |
| recommendation  | 8005  | `/recommendations/user/:id`, `/notifications`                           |

No Docker Compose, o gateway escuta na porta `8000` do container, exposta no host
em `8080` (`8080:8000`).

## Tecnologias

- **Node.js + TypeScript** (módulos ESM), executados com `tsx`.
- **Express 4** em cada serviço; **http-proxy-middleware** no gateway.
- **Prisma 6** para acesso a dados, com um schema por serviço.
- **jose** para emissão e validação de JWT; **bcryptjs** para hash de senha.
- **PostgreSQL 16**, com um banco lógico por serviço.
- **Docker** e **Docker Compose** para orquestração local.

## Execução local (Docker Compose)

Pré-requisito: Docker e Docker Compose.

```bash
cp .env.example .env      # ajuste AUTH_SECRET, se desejar
docker compose up --build
```

O comando sobe o PostgreSQL — com os cinco bancos lógicos criados pelo script de
inicialização — e os seis serviços. Quando todos estiverem prontos, o gateway
responde em `http://localhost:8080`.

Verificação rápida:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/services   # estado de todos os serviços
curl http://localhost:8080/catalog/books      # catálogo (rota pública)
```

O Auth executa o seed na inicialização, criando um administrador padrão:

```
admin@biblioflix.com / admin123
```

Altere essas credenciais antes de qualquer ambiente público. O catálogo também
nasce com livros e categorias de exemplo.

## Variáveis de ambiente

| Variável                            | Serviços                       | Descrição                                                        |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `AUTH_SECRET`                       | gateway, auth                  | Segredo do JWT. Deve ser idêntico nos dois serviços.             |
| `FRONTEND_ORIGIN`                   | gateway                        | Origem liberada no CORS (URL do frontend).                       |
| `DATABASE_URL`                      | cada serviço                   | String de conexão do banco daquele serviço.                      |
| `GRAVE_OVERDUE_DAYS`                | loan                           | Dias de atraso que bloqueiam novo empréstimo (padrão: `7`).      |
| `AUTH_URL`, `CATALOG_URL`, `LOAN_URL`, `FINE_URL`, `RECOMMENDATION_URL` | gateway, loan, fine, recommendation | URLs internas dos serviços para a comunicação HTTP. |

Em produção, gere o `AUTH_SECRET` com um valor aleatório, por exemplo
`openssl rand -base64 32`.

## Regras de negócio

- O status do empréstimo é derivado: `pending`, `active`, `overdue` ou
  `returned`.
- Multa de R$ 1,00 por dia de atraso.
- Uma reserva é um empréstimo sem retirada e expira em 30 minutos, liberando a
  cópia automaticamente.
- Um leitor pode manter no máximo uma cópia por título e três empréstimos ativos
  ao mesmo tempo.
- Leitores com atraso grave ficam impedidos de iniciar novos empréstimos. O
  limite é configurável por `GRAVE_OVERDUE_DAYS` (padrão de 7 dias).

## Deploy

O projeto roda integralmente em planos gratuitos.

1. **Banco — Neon.** Crie um projeto e, dentro dele, os bancos `auth_db`,
   `catalog_db`, `loan_db`, `fine_db` e `reco_db`. Anote a connection string de
   cada um.
2. **Serviços — Render.** Publique o repositório no GitHub e crie um Blueprint a
   partir do `render.yaml`. No painel, preencha o `DATABASE_URL` de cada serviço
   (Neon), o `AUTH_SECRET` (igual no gateway e no auth) e as variáveis `*_URL` do
   gateway, loan, fine e recommendation. Essas URLs só existem após o primeiro
   deploy, então preencha-as e faça um novo deploy do gateway.
3. **Frontend — Vercel.** No repositório `biblioflix-frontend`, defina
   `NEXT_PUBLIC_API_URL` com a URL pública do gateway.
4. No gateway, defina `FRONTEND_ORIGIN` com a URL da Vercel.

No plano gratuito do Render, os serviços hibernam após um período de
inatividade, e a primeira requisição seguinte sofre com *cold start*. Antes de
uma demonstração, acesse cada serviço uma vez para reativá-los.

## Limitações conhecidas

- **Exemplares físicos.** A disponibilidade é calculada por contagem
  (`totalCopies` / `availableCopies`), e não por exemplares individuais. A
  evolução natural é introduzir a entidade `Copy` no Catalog e vincular cada
  empréstimo a uma cópia específica.
- **Relatório de livros mais emprestados.** Depende de um cruzamento entre
  Catalog e Loan que ainda não é exposto entre serviços. Os relatórios atuais
  cobrem acervo, usuários e empréstimos consolidados.
- **Fila de reservas.** A reserva atual segura uma cópia disponível; a fila de
  espera para quando não há cópias é uma evolução prevista do Loan.
