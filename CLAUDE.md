# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

## What this is

A **Patient Q&A AI Assistant** — a vertical-slice prototype of a clinician-facing
assistant that answers questions about patients within a selected cohort
(**Group A** / **Group B**), grounded strictly in their records. This is a
take-home assignment (`task/task.md`); the deadline is **June 6th, 8pm PT**.

The grading rubric values, in order: **architecture, safety (cohort isolation
+ prompt-injection defense), and evaluation**. It explicitly de-prioritizes
full auth, polished UI, and medical correctness. Optimize work accordingly.

## Current state vs. goal

**Done (this milestone):** a runnable skeleton + a seeded PostgreSQL database.
The backend is a Nest.js scaffold exposing only `/` and `/health`; the frontend
is a single placeholder Expo screen. **No agent, retrieval, auth, or
evaluation exists yet.**

**Still to build** (see "Build-out plan" below): cohort selection + session
token, the LangChain Q&A agent (patient resolution → cohort-scoped retrieval →
grounded answer with citations + confidence), layered prompt-injection
defenses, deterministic A/B prompt variants with metrics, per-request
observability logging, an evaluation dataset, and the `SECURITY.md` /
`EXPERIMENT_RESULTS.md` deliverables.

## Tech stack (required — do not substitute)

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 16 (Docker, `docker-compose.yml`) |
| ORM / seeding | Prisma 6 |
| Backend | Nest.js 11 (TypeScript) |
| Frontend | Expo / React Native 0.76 (TypeScript) |
| LLM orchestration | LangChain 1.x (`langchain` + `@langchain/openai`; see "LangChain reference" below) |

The assignment mandates this exact stack. Don't introduce a different framework
or ORM.

## LangChain reference (use 1.x APIs + live docs)

This project uses **LangChain 1.x** (the current stable line; `langchain@^1`,
`@langchain/core@^1`, `@langchain/openai@^1`). **Do not use legacy 0.3 APIs**
(`createToolCallingAgent`, `AgentExecutor`) — they're replaced in 1.x.

**Canonical 1.x patterns** (verified against the live docs):
- Tools: `import { tool } from "langchain"` (also re-exported from `@langchain/core/tools`)
  + a **Zod** schema. `tool(fn, { name, description, schema })`.
- Agents: `import { createAgent } from "langchain"` →
  `createAgent({ model, tools, ... })` (the prebuilt agent; built on LangGraph internally).
- Models: `import { ChatOpenAI } from "@langchain/openai"`.

**When writing or editing any LangChain code, consult the official 1.x docs on demand**
(your training data may lag behind 1.x). Two ways, in order of preference:
1. **context7 MCP** — `resolve-library-id` → `query-docs` (prefer over web search for
   library docs).
2. **Fetch the page markdown** — append **`.md`** to any framework doc URL under
   `https://docs.langchain.com/oss/javascript/...` to get clean markdown
   (e.g. `…/langchain/tools.md`, `…/langchain/agents.md`).

**llms.txt:** `https://docs.langchain.com/llms.txt` is the published index, but note it is
**LangSmith/platform-API-focused**, not the agent/tool framework guides — those live under
`…/oss/javascript/*`. (`…/llms-full.txt` is the full concatenated dump, >10MB; fetch
specific pages instead.)

Key framework pages: Tools (`/oss/javascript/langchain/tools`), Agents
(`/oss/javascript/langchain/agents`), Models / ChatOpenAI
(`/oss/javascript/integrations/chat/openai`).

## Repository layout

```
patients-qa/
├── docker-compose.yml        # PostgreSQL service (host port 5433)
├── .env                      # SINGLE source of truth (gitignored — copy from .env.example)
├── .env.example              # canonical key set: DATABASE_URL, OPENAI_API_KEY, JWT_SECRET,
│                             #   LANGSMITH_*, OPENAI_GUARD_MODEL, NEXT_PUBLIC_* for admin
├── backend/                  # Nest.js + Prisma
│   ├── prisma/
│   │   ├── schema.prisma     # 5 models mapped 1:1 to the CSV tables
│   │   ├── seed.ts           # idempotent CSV -> DB seeder
│   │   ├── seed-data/        # copies of the source CSVs (seeder reads these)
│   │   └── migrations/       # `20260604042558_init`
│   └── src/
│       ├── main.ts           # bootstrap, CORS enabled, PORT env (default 3000)
│       ├── app.module.ts     # ConfigModule (global) + PrismaModule
│       ├── app.controller.ts # GET / and GET /health
│       ├── app.service.ts    # health check + seeded row counts
│       └── prisma/           # PrismaService (connect/disconnect lifecycle)
├── frontend/                 # Expo app (single placeholder App.tsx)
└── task/                     # assignment brief + original CSVs (gitignored)
```

## Commands

All backend commands run from `backend/`. All frontend commands from `frontend/`.

### Database (from repo root)
```bash
docker compose up -d            # start Postgres (host port 5433)
docker compose ps               # wait for the db service to be healthy
docker compose down             # stop;  add -v to wipe the volume
```

### Backend
```bash
cd backend
# (.env lives at the repo root — copy from /.env.example once before any of these)
npm install
npm run prisma:migrate -- --name <name>   # apply/author migrations
npm run db:seed                           # load CSVs (idempotent — clears then re-inserts)
npm run start:dev                         # Nest watch mode -> http://localhost:3000
npm run build                             # nest build -> dist/
npx prisma studio                         # visual data browser (loads ./prisma/schema.prisma;
                                          #   needs DATABASE_URL — easiest via `npm run` wrappers)
```

> All env-aware npm scripts are wrapped with `node --env-file=../.env …` so they
> read the root `/.env`. Don't create `backend/.env` — it's no longer loaded.
> Direct `prisma` / `ts-node` invocations from `backend/` won't see env vars
> unless you prefix them with `node --env-file=../.env ./node_modules/.bin/…`.

Convenience scripts (in `backend/package.json`): `db:seed`, `db:reset`
(drop + re-migrate + re-seed), `prisma:generate`, `prisma:migrate`.

Health check (confirms DB connectivity + seeded counts):
```bash
curl http://localhost:3000/health
# -> { "status":"ok", "database":"connected",
#      "counts": { "patients":120, "allergies":97, "conditions":1695,
#                  "medications":937, "observations":775 } }
```

### Frontend
```bash
cd frontend
npm install
npm start                       # Metro dev server (port 8081); press w/i/a, or scan QR
npm run web                     # browser via react-native-web
```

> There are **no test, lint, or typecheck scripts** wired up yet. If you add a
> feature, add the corresponding script and run it before claiming completion.
> For a quick TS check use `npx tsc --noEmit` in the relevant package.

## Data model

Five tables imported verbatim from the CSVs. Field names are **camelCase in
Prisma**, mapped to the original **snake_case columns** via `@map` / `@@map`.

| Table | Rows | Notes |
|-------|------|-------|
| `patient` | 120 | Carries the cohort key `group` (`A`/`B`): **65 in A, 55 in B** |
| `patient_allergy` | 97 | FK `patientId` |
| `patient_condition` | 1695 | ICD-10 coded diagnoses |
| `patient_medication` | 937 | Prescriptions + directions; `narcotic` flag |
| `patient_observation` | 775 | Vitals/metrics as JSON in `data`, e.g. `{"type":"PainLevel","value":0}` |

Child records FK to `patient.id` with `onDelete: Cascade`. Indexes exist on
`patient.group` and on every `patientId` FK so cohort-scoped queries stay cheap.

### ⚠️ Cohort isolation — the central safety invariant

**Only `Patient` has a `group` column.** Child records inherit cohort solely
through `patientId → patient.group`. There is **no DB-level enforcement** of the
boundary — it must live in the application layer. Every read MUST be scoped to
the active cohort by joining/filtering through `patient.group`. Treat any
cross-cohort access (or attempt) as a **high-severity security event** that is
blocked, logged, and answered with the safe fallback. When you write retrieval
code, never expose a query path that can reach a patient outside the caller's
group.

Safe fallback string (use verbatim):
> *"I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records."*

## Build-out plan (derived from `task/task.md`)

Implement these as cohort isolation runs through all of them. Suggested order:

1. **Cohort selection + session token.** A `POST` group-selection endpoint
   (the only route exempt from auth) returns a session token encoding the
   chosen group (`A`/`B`). All other requests must carry it as Basic auth; a
   Nest guard rejects missing/invalid tokens and resolves the active cohort.
2. **LangChain Q&A agent.** Given a free-text question, the agent must:
   **resolve** the referenced patient (by name, ID, or description) *within the
   active cohort*, **retrieve** only that patient's records, and return a
   **concise answer + citations to specific source records + confidence
   (`High`/`Medium`/`Low`)**. No match / insufficient evidence → safe fallback.
3. **Layered prompt-injection defenses.** Anticipate and resist: system-prompt
   override, cross-cohort access, cross-group enumeration, system-prompt/env
   exfiltration. Defense in depth — don't rely on a single prompt instruction.
4. **A/B testing.** Two prompt/agent variants with **deterministic per-session
   assignment**, per-variant metrics, and a written comparison in
   `EXPERIMENT_RESULTS.md`. Isolation rules apply equally to both variants.
5. **Observability.** Log for **every** request: active cohort, resolved
   patient ID, prompt variant, records retrieved (with source-table refs), raw
   model output, structured response (answer/citations/confidence), and any
   detected injection attempt or cohort boundary violation.
6. **Evaluation dataset + metrics.** ≥10 normal in-cohort Qs, ≥8 injection
   attempts, ≥5 cross-group access attempts, ≥5 insufficient-context Qs. For
   cross-group tests, record whether each was **blocked**, **logged**, and got a
   safe response.

### Required deliverable docs
- `README.md` — setup, run, architecture (already exists; keep it current).
- `SECURITY.md` — threat model, implemented defenses, known risks/limitations.
- `EXPERIMENT_RESULTS.md` — variants, eval dataset, per-variant metrics,
  recommendation.
- Answer the prompt: *"What would you improve with one additional day?"*

### Stretch: hosted deployment
Public URL for the full stack (frontend + backend + DB), stable through the
review window, secrets via env vars only (never committed). Put the live URL in
`README.md`.

## Conventions & gotchas

- **Postgres is on host port 5433**, not 5432 (avoids clashing with a local
  Postgres). The `DATABASE_URL` in `/.env.example` already matches.
- **One env file at the repo root** (`/.env`). All apps load it: backend via
  `node --env-file=../.env …` baked into npm scripts (with
  `ConfigModule.envFilePath: '../.env'` as a fallback), admin via
  `dotenv.config()` at the top of `next.config.ts`. **Do not** create
  `backend/.env` or `admin/.env.local` — they're no longer read. LLM keys
  (`OPENAI_API_KEY` etc.) and `JWT_SECRET` go in `/.env`. **Never hardcode or
  commit secrets.** `.env` / `*.env` are gitignored (`.env.example` is the
  exception).
- **Seeding is idempotent**: `seed.ts` deletes children-first then re-inserts in
  batches of 500. The CSVs have quirks the seeder handles defensively — keep
  this behavior if you touch it:
  - timestamps like `2015-12-26 16:25:00.000 -0800` (space separator, offset
    without colon) — JS `Date` can't parse as-is; `parseTs` normalizes to ISO.
  - empty strings mean null (`nullify`); booleans are `"TRUE"`/`"FALSE"` (`bool`).
  - `legal_mailing_address` and observation `data` are JSON strings (`json`).
- **Prisma source of truth is `schema.prisma`.** After editing it, run
  `prisma migrate dev` and `prisma generate`; don't hand-edit generated client
  or migration SQL.
- **`task/` is gitignored** — it holds the brief and original CSVs and is not
  part of the deliverable. The seeder reads its own copies in
  `backend/prisma/seed-data/`, not `task/csvs/`.
- Backend CORS is enabled globally (`main.ts`) for the Expo client. Port is
  overridable via `PORT` env.

## Working agreement

- **Cohort isolation and injection defense are correctness requirements, not
  nice-to-haves.** When adding any data-access path, prove it cannot leak across
  groups, and add an eval case for it.
- Match the existing style: camelCase Prisma fields with `@map`, defensive
  null-handling, small focused Nest modules/services, clear comments explaining
  *why* (as in `seed.ts`).
- **Never commit or push to Git.** The user handles all commits themselves. Do not run
  `git commit` / `git push`, create branches, or otherwise automate version control at any
  point — including at the end of a task. Leave all changes in the working tree for the user
  to review and commit.
- Prefer extending the existing scaffold over rewriting it.
