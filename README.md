# Traiblazer

Multi-tenant AI assistant (chatbot / RAG) platform for small businesses. See [docs/PLAN.md](docs/PLAN.md)
for the product plan and roadmap.

**Status:** Phase 0 (foundations) — monorepo, database with row-level security, auth, businesses
(tenants) and assistants (bots) API, EN/FR admin portal skeleton, language registry. No chat/RAG yet.

## Layout

```
apps/
  api/              Fastify API: auth, tenants, bots, business profiles, catalog
  admin/            Next.js admin portal (EN/FR, RTL-ready), proxies /api/* to the API
packages/
  db/               Drizzle schema, migrations (incl. row-level security), withTenant()
  i18n/             Language registry (tiers, RTL), UI messages (ICU), language negotiation
  industry-packs/   Sector → pack → variant catalog with rollout phases
  shared/           Zod request schemas shared by API and admin
infra/postgres/     Local database init (roles, test database)
```

## Requirements

- Node.js 22.12+ (26 LTS used locally) and pnpm 10 (`npm install -g pnpm@10`)
- Docker (Postgres 17 + pgvector, Redis)

## Getting started

```bash
cp .env.example .env
pnpm install
pnpm db:up          # Postgres on localhost:5433, Redis on 6379
pnpm build          # builds the shared packages
pnpm db:migrate
pnpm db:seed        # demo@traiblazer.local / demo-password-123
pnpm dev            # API on :4000, admin on :3000
```

Open http://localhost:3000 and sign in with the demo account.

## Checks

```bash
pnpm lint           # Biome (lint + format check); `pnpm format` to fix
pnpm typecheck
pnpm test           # needs `pnpm db:up`; uses the traiblazer_test database
```

CI (`.github/workflows/ci.yml`) runs the same steps against the docker-compose services.

## Multi-tenancy and security model

- Every tenant-owned table has `tenant_id` and a Postgres **row-level security** policy
  (`packages/db/migrations/0001_rls.sql`).
- The API connects as `traiblazer_app`, which is not a superuser and cannot bypass RLS. Tenant-scoped
  work runs inside `withTenant(db, tenantId, fn)`, which sets `app.tenant_id` for that transaction only.
- Child tables reference `(bot_id, tenant_id)` together, so a row can never point at another
  tenant's bot.
- Widget keys are resolved through a `SECURITY DEFINER` function (`app_resolve_bot_key`), so the app
  role never needs cross-tenant reads.
- Non-members get `404` for another business's routes. Roles: owner > admin > editor > viewer.
- Passwords: scrypt (N=2^17); sessions: random token in an httpOnly SameSite=Lax cookie, only its
  SHA-256 is stored. Sign-in/sign-up are rate-limited per IP.

## Adding a migration

Edit `packages/db/src/schema.ts`, then:

```bash
pnpm db:generate    # writes a new SQL file to packages/db/migrations
pnpm db:migrate
```

New tables get privileges for `traiblazer_app` automatically; **add an RLS policy** in the migration
for every new tenant-owned table, and a test in `packages/db/src/rls.test.ts`.
