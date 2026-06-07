# Patient Q&A AI Assistant

A clinician-facing assistant that answers questions about patients within a
selected cohort (**Group A** / **Group B**), grounded strictly in their records.
Pick a cohort, ask in plain language ("does Maria Lopez have any drug
allergies?"), and get a concise answer with **citations to the source records**
and a **confidence level** — never crossing the cohort boundary.

## Stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 16 + pgvector (Docker) |
| ORM / seeding | Prisma 6 |
| Backend | Nest.js 11 (TypeScript) |
| LLM orchestration | LangChain 1.x (`langchain` + `@langchain/openai`) |
| Frontend | Expo / React Native 0.76 (web + native) |
| Admin panel | Next.js (static SPA) |

## Architecture overview

Four moving parts around one Postgres database:

```
┌───────────┐   ┌───────────┐        ┌──────────────────────────────┐   ┌──────────────┐
│ Frontend  │   │  Admin    │        │          Backend             │   │  PostgreSQL  │
│ Expo app  │──▶│ Next.js   │──────▶ │          Nest.js             │──▶│  + pgvector  │
│ (chat UI) │   │ (logs/    │  HTTP  │  auth · QA agents · guards   │   │  patients +  │
│  :8081/80 │   │  metrics) │        │  observability   :3000       │   │  embeddings  │
└───────────┘   │   :3200   │        └──────────────────────────────┘   │    :5433     │
                └───────────┘                                            └──────────────┘
```

- **PostgreSQL + pgvector** — the 5 patient tables (patient, allergy, condition,
  medication, observation), plus `allergen` / `icd_code` vocabulary tables that
  carry `vector(1536)` embeddings for semantic search, plus a `request_log`
  audit table. Only `patient` has the cohort key `group`; child records inherit
  it through `patientId → patient.group`.

- **Backend (Nest.js + Prisma + LangChain)** — the brains. Key routes:
  - `POST /auth/session` — the only public route: pick a cohort (`A`/`B`), get
    back a signed session token (sent as Basic auth on every later request) and a
    deterministic A/B variant assignment.
  - `POST /qa/query` (and its SSE twin `POST /qa/stream`) — the one chat endpoint.
    No `patientId` ⇒ **FIND** (resolve/search patients *within the cohort*);
    `patientId` set ⇒ **ANSWER** (grounded answer + citations + confidence from
    *that* patient's records only).
  - `GET /qa/logs`, `GET /qa/metrics`, `GET /qa/metrics/category` — observability
    and A/B / per-category evaluation.
  - `GET /health` — DB connectivity + seeded row counts.

  **Safety is enforced here, not in the DB:** a cohort auth guard scopes every
  read to the caller's group, and layered prompt-injection defenses (structural
  output ceilings + an opt-in classifier) sit in front of the agents. Two agent
  variants (`structured` vs `tool_calling`) back the A/B test.

- **Frontend (Expo)** — the clinician chat UI (web via `react-native-web`, or
  native via Expo Go / simulators): cohort selection, patient search, Q&A with
  citations, confidence, and a token-usage meter.

- **Admin (Next.js)** — a static SPA that reads the audit log and renders it as a
  searchable table plus the A/B and per-category scorecards.

**Request flow:** select cohort → token → ask → backend FINDs the patient *in
your cohort* → retrieves only that patient's records → returns a grounded answer
with citations + confidence. Every request is logged.

## Prerequisites

- **Node.js 22+** and npm
- **Docker + Docker Compose** (for the server install, or to run just the DB locally)
- An **OpenAI API key** (the agents and embeddings call OpenAI)

## Configuration

There is **one env file**, `/.env` at the repo root — every app loads it. Copy
the template and fill in the required values before starting anything:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | ✅ | Used by the find/answer agents and embeddings. |
| `JWT_SECRET` | ✅ | Signs cohort session tokens. Use `openssl rand -hex 32`. |
| `DATABASE_URL` | ✅ | Defaults to the local DB on port **5433**. |
| `PUBLIC_HOST` | server only | The server's public IP/domain. Baked into the frontend & admin builds so the browser can reach the backend. Set it for the Docker Compose install. |

---

## Installation on the Server (Docker Compose)

Everything — database, backend, frontend, and admin — runs in containers. **First
start (including restoring the database):**

1. **Configure env.** `cp .env.example .env`, then set `OPENAI_API_KEY`,
   `JWT_SECRET`, and add `PUBLIC_HOST` (the server's public IP or domain).
2. **Start the database** and wait for it to be healthy:
   ```bash
   docker compose up -d db
   docker compose ps
   ```
3. **Restore the database** (schema + data + pgvector embeddings) from the
   bundled dump — this skips recomputing embeddings:
   ```bash
   cd db-dump && ./restore.sh --compose -y && cd ..
   ```
4. **Start the rest of the stack** (builds and runs backend, frontend, admin):
   ```bash
   docker compose up -d
   ```
5. **Open the apps:**
   - Frontend (chat): `http://<PUBLIC_HOST>/`
   - Admin (logs/metrics): `http://<PUBLIC_HOST>:3200/`
   - Backend health: `http://<PUBLIC_HOST>:3000/health`

**Start / stop afterwards:**

```bash
docker compose up -d     # start the whole stack
docker compose down      # stop it (add -v to also wipe the DB volume)
```

---

## Local Installation (without Docker)

Run each app natively with Node. You need a **PostgreSQL 16+ with the `pgvector`
extension** reachable at the `DATABASE_URL` in `/.env` (the default expects port
**5433**).

> 💡 If you'd rather not install pgvector by hand, the one-liner
> `docker compose up -d db` gives you exactly the right Postgres on `:5433` while
> you still run the apps natively below.

**First start (including restoring the database):**

1. **Configure env.** `cp .env.example .env`, then set `OPENAI_API_KEY`,
   `JWT_SECRET`, and point `DATABASE_URL` at your Postgres.
2. **Restore the database** (schema + data + embeddings) via host `psql` — needs
   `psql` 16+ on your machine:
   ```bash
   cd db-dump && ./restore.sh && cd ..
   ```
3. **Backend** → http://localhost:3000
   ```bash
   cd backend && npm install && npm run start:dev
   ```
   Verify: `curl http://localhost:3000/health` should report `"database":"connected"`
   with 120 patients.
4. **Frontend** → http://localhost:8081 (press `w` for web, or `i`/`a`/scan the QR)
   ```bash
   cd frontend && npm install && npm start
   ```
5. **Admin** → http://localhost:3200
   ```bash
   cd admin && npm install && npm run dev
   ```

The frontend and admin both default to the backend at `http://localhost:3000`,
so no extra URL config is needed for local runs.

**Start commands afterwards:** `npm run start:dev` (backend), `npm start`
(frontend), `npm run dev` (admin) — each from its own directory.

---

## Useful backend scripts

Run from `backend/` (each loads `/.env` automatically):

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Run Nest.js in watch mode (port 3000). |
| `npm run db:seed` | Seed the DB from the source CSVs (idempotent). |
| `npm run db:reset` | Drop, re-migrate, and re-seed. |
| `npx prisma studio` | Visual data browser. |

> **Seed vs. restore:** `db:seed` rebuilds the relational data from CSVs but does
> **not** include the pgvector embeddings (those are recomputed via the
> `db:embed-*` scripts and cost OpenAI tokens). For a complete, ready-to-use DB,
> prefer `db-dump/restore.sh` as shown above.
