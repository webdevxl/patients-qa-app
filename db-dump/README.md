# db-dump

Portable dump of the `patients_qa` Postgres database split into three layers so
that the bulky pgvector embeddings can be shipped, stored, and restored
independently from the relational data.

## Files

| File | Contents | Size |
|------|----------|------|
| `sql/schema.sql` | DDL only: `vector` extension, all tables (incl. the `embedding` columns), indexes, foreign keys, Prisma migrations table. Begins with `DROP TABLE IF EXISTS …` so re-running is safe. | small |
| `sql/data.sql` | Row data for **every** table. `allergen` and `icd_code` are written with their `embedding` column **omitted** — those rows are seeded here without vectors. | small |
| `sql/embeddings.sql` | The `vector(1536)` payloads for `allergen.embedding` and `icd_code.embedding`. Loads into a temp table and `UPDATE`s the parent rows in place, so it's safe to run on a DB that already has the schema + data. | ~10 MB |
| `restore.sh` | Restore script. Loads `sql/*.sql` in three modes (local psql, `docker exec`, `docker compose exec`). | — |
| `dump.sh` | Regenerates the three `sql/*.sql` files from a running source database. Defaults to the local `patients-qa-db` docker container. | — |

## Target requirements

Postgres **16+** with the `vector` extension available (e.g. the
`pgvector/pgvector:pg16` image). The dump uses Postgres-16 `\restrict`
meta-commands, so an older psql client will fail to parse it.

## Where to run the script from

**Always invoke `restore.sh` from inside the `db-dump/` directory** (i.e. with
`./restore.sh …`). The script uses absolute paths derived from its own
location — *not* `$PWD` — so it can find the three SQL files and the sibling
`/.env` and `docker-compose.yml`. Running it from elsewhere works too, but the
defaults assume the standard layout:

```
project-root/
├── .env                    ← DATABASE_URL for --mode local (single source of truth)
├── docker-compose.yml      ← used by default for --mode compose
└── db-dump/                ← cd here and ./restore.sh
    ├── restore.sh
    ├── dump.sh
    └── sql/                 ← the dump files live here
        ├── schema.sql
        ├── data.sql
        └── embeddings.sql
```

## Restoring on a server (Docker / Docker Compose)

The server doesn't need `psql` installed on the host — the script pipes each
SQL file into the psql binary that already lives inside the DB container.
Likewise, the root `/.env` file is **not required** for `--docker` or
`--compose` modes (the container connects via local socket).

```bash
# 1) Copy this db-dump/ directory onto the server (inside the project repo
#    so docker-compose.yml is at ../docker-compose.yml).
cd /opt/patients-qa-app/db-dump

# 2) Bring up the DB container and wait for it to be healthy.
docker compose -f ../docker-compose.yml up -d db
docker compose -f ../docker-compose.yml ps

# 3) Restore — pick one of:

# (a) docker exec into the container by name (matches docker-compose.yml
#     container_name: patients-qa-db).
./restore.sh --docker -y

# (b) Or go through the compose project (no fixed container_name needed).
#     --compose-file defaults to ../docker-compose.yml so you don't need to
#     pass it explicitly when running from db-dump/.
./restore.sh --compose -y
```

`--yes` (or `-y`) skips the destructive-action confirmation. Drop it if you
want to be prompted.

In either docker-based mode the script:

- checks the container/service is actually running before doing anything,
- pipes the SQL files in over stdin (no need to mount or `docker cp` them),
- applies `schema.sql` → `data.sql` → `embeddings.sql` in order,
- aborts on the first SQL error (`-v ON_ERROR_STOP=1`),
- wraps `schema.sql` and `data.sql` in single transactions so a partial restore
  can't leave the DB half-broken (`embeddings.sql` has its own per-table
  transactions),
- prints a row-count sanity check at the end.

### Pointing at a non-default container or service

```bash
./restore.sh --docker --container my-pg --db-user app --db-name app_db -y

./restore.sh --compose --service postgres --compose-file ./infra/compose.yml \
             --db-user postgres --db-name app_db -y
```

### Skipping embeddings

If you want a fast schema + data restore for testing and intend to backfill
embeddings later with the existing `embed-*-compute.ts` scripts:

```bash
./restore.sh --docker -y --skip-embeddings
```

## Restoring on a dev laptop (host psql)

```bash
# Default — reads ../.env (the single source of truth) for DATABASE_URL.
./restore.sh

# Or point at a different .env:
./restore.sh --env /path/to/.env
```

Requires `psql` 16+ on the host. The `.env` file must define `DATABASE_URL`,
e.g. `DATABASE_URL="postgresql://user:pass@host:5432/dbname"`.

## Regenerating the dump

```bash
./dump.sh                          # from the local docker container (default)
./dump.sh --container some-pg      # from a different container
./dump.sh --db-url postgres://…    # from any reachable Postgres (uses host pg_dump)
```

## Row counts at dump time

| Table | Rows |
|-------|------|
| `patient` | 120 |
| `patient_allergy` | 98 |
| `allergen` | 50 (all embedded) |
| `patient_condition` | 1695 |
| `patient_medication` | 937 |
| `patient_observation` | 775 |
| `icd_code` | 517 (all embedded) |
| `request_log` | 239 |
| `_prisma_migrations` | 3 |
