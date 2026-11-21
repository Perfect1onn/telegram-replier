# Telegram AI Replier

**Status: incomplete. Do not deploy or enable AUTO.** Read [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for verified behavior and remaining gaps. No live Telegram message or paid OpenAI request was made during development.

## Safe local checks

Use Node.js 24. Copy `.env.example` to `.env` only when preparing local services; keep `.env` private. The default `AUTOREPLY_ENABLED=false` and new chats default to OFF. The database `system_state` also starts paused.

```sh
npm ci --ignore-scripts
npm run db:generate
npm run check
```

`npm run check` runs formatting, ESLint, strict TypeScript and unit/fake tests. It does not contact Telegram or OpenAI. `npm run smoke` is an in-process fake pipeline check.

## Isolated integration tests

Use a dedicated PostgreSQL 16 database with pgvector and a dedicated Redis instance. Set `DATABASE_URL` for migrations, and `TEST_DATABASE_URL`/`TEST_REDIS_URL` for tests. Never point these at personal or production data.

```sh
npm run db:migrate
npm run test:integration
```

The integration suite performs real Prisma transactions, BullMQ publication, pgvector search, and admin route checks. Its model calls use fake embeddings and its send check uses a fake Telegram gateway.

## Docker Compose

Set a fresh `POSTGRES_PASSWORD` and `ADMIN_JWT_SECRET` in `.env`. `docker compose up -d postgres redis` starts only project database and queue services. `docker compose --profile app up --build` additionally runs migrations and starts the backend; this requires an existing 0600 `.telegram-session` file, an `.admin-public.pem` file, and valid Telegram/OpenAI API configuration. The Compose app profile **forces `AUTOREPLY_ENABLED=false`** and exposes admin only on host loopback port 8787. The app's container bind to `0.0.0.0` is allowed only by the explicit `ADMIN_ALLOW_CONTAINER_BIND=true` override in Compose; API endpoints require a signed JWT.

For local process startup after preparing services and a session, use `node --env-file=.env src/main.ts`. Do not run this against a personal Telegram session as a smoke test. The runtime has not passed a live session/identity/reconnect check.

## Operations

The React admin UI is served at `/admin/` on the admin port. Generate a P-256 key pair with `npm run admin:keygen`; keep `.admin-auth.private.pem` on your own machine and copy only `.admin-auth.public.pem` to the server as `.admin-public.pem`. The UI lets you select the private PEM file locally. It signs a one-time challenge in the browser and receives a 15-minute JWT; the private key and JWT stay in memory and are not persisted in browser storage. A new JWT is obtained automatically while the tab remains open. The Compose app port stays bound to host loopback; for private remote access, use an SSH tunnel such as `ssh -L 8787:127.0.0.1:8787 opc@YOUR_SERVER`, then open `http://127.0.0.1:8787/admin/`. Do not expose port 8787 publicly.

For public HTTPS access on a server with a stable public IPv4 address, set `ADMIN_PUBLIC_HOST` to that address in `.env`, allow inbound TCP 80 and 443 in the cloud network and host firewall, then run `docker compose --profile app --profile public up -d`. The optional Caddy service proxies only `/admin`, `/auth/challenge`, `/auth/verify`, and `/api/*` to the backend. It obtains and renews a short-lived Let's Encrypt IP certificate; its certificate data lives in a Docker volume. Open `https://YOUR_PUBLIC_IP/admin/`. Keep the private PEM file on your own machine. Public access does not change the key-based login or enable AUTO. The UI shows system status and usage, allows global pause/resume, chat configuration, backfill, draft review, UNKNOWN send reconciliation, and confirmed chat data purge. AUTO still requires explicit server configuration and live validation before use.

Admin endpoints include chat config, pause, drafts, status, usage, durable backfill, explicit UNKNOWN send reconciliation and chat purge. Purge requires `{ "confirm": "PURGE <chatId>" }`. Backfill uses `POST /api/chats/:chatId/backfill` and `GET /api/chats/:chatId/backfill`. Inspect UNKNOWN sends with `GET /api/sends/unknown`; verify Telegram history before calling `POST /api/sends/:id/reconcile`. A `NOT_SENT` conclusion requires independent human verification because a missing item in a limited history page is not proof of non-delivery. UNKNOWN sends are never retried automatically. See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) for the tested database backup format and restore limits. Before operational use, finish the remaining items in `IMPLEMENTATION_REPORT.md`, especially live session/reconnect validation and recovery procedures.

The admin UI also has an **О тебе** questionnaire for facts, writing preferences and cross-chat boundaries. Search can use indexed messages from all allowed chats, but only the account owner's own outgoing messages are passed from another chat. The current chat receives a rolling summary built from its messages in the last 183 days. Summary generation runs one batch per minute, shares the configured `LLM_DAILY_BUDGET_USD` with replies, and pauses until the next UTC day when the budget is exhausted. Its progress is shown in chat settings. Set `RETENTION_DAYS=183` or higher, then use **Обновить 6 месяцев** for a chat already marked as fully imported; this sends `POST /api/chats/:chatId/backfill` with `{ "restart": true }`. The backfill stops at the six-month cutoff, and its completed summary becomes available to replies only after all stored messages have been processed. The profile fields and owner message examples are used across chats; review the questionnaire and the privacy implications before enabling AUTO.
