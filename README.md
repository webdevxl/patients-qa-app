# Patient Q&A AI Assistant

A vertical-slice prototype of a clinician-facing assistant that answers questions about patients within a selected cohort (Group A / Group B), grounded in their records.

> **Status: starting scaffold.** This milestone delivers a runnable project skeleton and a **seeded PostgreSQL database**. The Q&A agent, cohort-scoped retrieval, prompt-injection defenses, A/B testing, and evaluation are **not implemented yet** — they build on this foundation.

## Stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 16 (Docker) |
| ORM / seeding | Prisma |
| Backend | Nest.js |
| Frontend | Expo (React Native) |
| LLM orchestration | LangChain *(installed, not yet wired up)* |

## Project layout

```
patients-qa/
├── docker-compose.yml        # PostgreSQL service
├── .env                      # single source of truth (gitignored — copy from .env.example)
├── .env.example              # canonical key set for backend + admin + tooling
├── backend/                  # Nest.js + Prisma
│   ├── prisma/
│   │   ├── schema.prisma     # 5 models mapped to the CSV tables
│   │   ├── seed.ts           # CSV -> DB seeder
│   │   └── seed-data/        # copies of the source CSVs
│   └── src/                  # app module, health endpoint, PrismaService
├── frontend/                 # Expo app (placeholder screen)
├── admin/                    # Next.js observability log viewer (static SPA, no SSR)
├── db-dump/                  # portable schema + data + embeddings dump w/ restore.sh + dump.sh
└── task/                     # assignment brief + original CSVs
```

> **One env file, top-level.** There are no per-app `.env` / `.env.local`
> files anymore — backend (via `node --env-file=../.env` baked into npm
> scripts + a `ConfigModule.envFilePath` fallback) and admin (via
> `dotenv.config()` at the top of `next.config.ts`) both load the root `/.env`
> directly. Keep new vars there.

## Data model

Five tables are imported verbatim from the provided CSVs:

| Table | Rows | Notes |
|-------|------|-------|
| `patient` | 120 | Carries the cohort key `group` (`A`/`B`): **65 in A, 55 in B** |
| `patient_allergy` | 97 | FK `patient_id` |
| `patient_condition` | 1695 | ICD-10 coded diagnoses |
| `patient_medication` | 937 | Prescriptions + directions |
| `patient_observation` | 775 | Vitals/metrics as JSON in `data` |

**Cohort isolation:** only `patient` has a `group` column; child records inherit cohort through `patient_id → patient.group`. The schema indexes `patient.group` and each `patient_id` FK so cohort-scoped queries stay cheap. Enforcement of that boundary lives in the (future) application layer.

## Prerequisites

- Node.js 20+ (tested on 22)
- Docker + Docker Compose
- For the frontend: the Expo Go app (iOS/Android) or a simulator, or just run on web

## Setup & run

### 1. Configure env + start PostgreSQL

```bash
cp .env.example .env            # required — all apps load /.env at the repo root
docker compose up -d
docker compose ps               # wait for the db service to be healthy
```

Postgres is exposed on host port **5433** (to avoid clashing with any Postgres
already on 5432); the connection strings in `.env.example` already match. Fill in
`OPENAI_API_KEY` and `JWT_SECRET` before running the backend — those are
required.

### 2. Backend — create schema, seed, run

```bash
cd backend
npm install
npm run prisma:migrate -- --name init   # creates the 5 tables
npm run db:seed                         # loads the CSVs
npm run start:dev                       # http://localhost:3000
```

> If port 3000 is already in use, set a different one: `PORT=3001 npm run start:dev`.

Verify it's up and the data landed:

```bash
curl http://localhost:3000/health
# -> { "status":"ok", "database":"connected",
#      "counts": { "patients":120, "allergies":97, "conditions":1695,
#                  "medications":937, "observations":775 } }
```

You can also browse the data with `npx prisma studio`.

### 3. Frontend (Expo)

```bash
cd frontend
npm install
npm start                       # starts the Metro dev server (port 8081)
```

Then choose how to open the app from the Expo CLI prompt:

| Key / command | Opens in | Requires |
|---------------|----------|----------|
| press `w` (or `npm run web`) | Browser, via `react-native-web` | — (web deps included) |
| press `i` | iOS Simulator | Xcode |
| press `a` | Android emulator | Android Studio / an emulator |
| scan the QR code | Your phone | the **Expo Go** app |

The app currently renders a placeholder screen confirming it builds.

> **Heads-up:** opening `http://localhost:8081` directly in a browser shows a
> JSON **manifest**, not the app — that's the Metro dev server's endpoint for
> native clients, and is expected. Let Expo open the browser tab for you (or
> press `w`); web mode then serves the actual rendered app on the same port.
> Note that web mode renders the UI full-window via `react-native-web` — it is
> **not** a phone-frame emulator. For a device frame, use `i` / `a` / Expo Go.

### 4. Admin panel — observability log viewer

A standalone **Next.js** app (client-rendered SPA, no SSR) that renders the observability
audit log (`GET /qa/logs`) as a sortable, filterable data table with a click-through detail
drawer (ShadCN). Styled to match the CareBrain brand.

```bash
cd admin
npm install
npm run dev                     # http://localhost:3200
```

Sign in with the primitive gate (`admin` / `admin` by default — configurable via
`NEXT_PUBLIC_ADMIN_USER` / `NEXT_PUBLIC_ADMIN_PASSWORD` in the root `/.env`). It needs the
**backend running on :3000** — the admin mints a cohort session token under the hood to
authorize `/qa/logs`. `npm run build` emits a fully static bundle to `admin/out/`;
`next.config.ts` loads `../.env` at startup so `NEXT_PUBLIC_*` vars are inlined.

> **⚠️ The login is a UI gate only, not real auth** — `NEXT_PUBLIC_*` values are inlined
> into the browser bundle. A real deployment would gate `/qa/logs` behind a server-side
> admin role (see `SECURITY.md`).
>
> **npm gotcha:** if `npm install` later fails to render styles with
> `Cannot find module '…lightningcss.darwin-arm64.node'`, your global `~/.npmrc` has
> `os=macos` (it should be `darwin`, or unset), which makes npm skip platform-specific
> optional deps. Fix the npmrc, or reinstall the binary with
> `npm install lightningcss-darwin-arm64 --os=darwin --cpu=arm64 --no-save`.

## Useful scripts (backend)

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Run Nest.js in watch mode |
| `npm run db:seed` | Re-seed the database (idempotent) |
| `npm run db:reset` | Drop, re-migrate, and re-seed |
| `npx prisma studio` | Visual data browser |

## Roadmap (not in this milestone)

- Cohort selection → session token → cohort-scoped requests
- LangChain agent: patient resolution + grounded retrieval + citations + confidence
- Layered prompt-injection / cross-cohort defenses
- Deterministic A/B prompt variants + metrics (`EXPERIMENT_RESULTS.md`)
- Per-request observability logging
- Evaluation dataset + `SECURITY.md`
