# db-dump

Portable dump of the `patients_qa` Postgres database split into three layers so
that the bulky pgvector embeddings can be shipped, stored, and restored
independently from the relational data.

## Files

| File | Contents | Size |
|------|----------|------|
| `schema.sql` | DDL only: `vector` extension, all tables (incl. the `embedding` columns), indexes, foreign keys, Prisma migrations table. Begins with `DROP TABLE IF EXISTS …` so re-running is safe. | small |
| `data.sql` | Row data for **every** table. `allergen` and `icd_code` are written with their `embedding` column **omitted** — those rows are seeded here without vectors. | small |
| `embeddings.sql` | The `vector(1536)` payloads for `allergen.embedding` and `icd_code.embedding`. Loads into a temp table and `UPDATE`s the parent rows in place, so it's safe to run on a DB that already has the schema + data. | ~10 MB |
| `install.sh` | Restore script. Reads `DATABASE_URL` from `../backend/.env` (overridable) and applies the three SQL files in order. | — |
| `dump.sh` | Regenerates the three SQL files from a running source database. Defaults to the local `patients-qa-db` docker container. | — |

## Restoring on a server

```bash
# 1) Place this entire db-dump/ directory on the target machine.
# 2) Ensure backend/.env exists alongside it (or pass --env <path>) and contains:
#       DATABASE_URL="postgresql://user:pass@host:5432/dbname"
# 3) Make sure the target Postgres is v16+ with pgvector available
#    (pgvector/pgvector:pg16 works out of the box).

./install.sh           # full restore (schema + data + embeddings)
./install.sh -y        # skip the destructive-action confirmation
./install.sh --skip-embeddings   # restore the relational data only
./install.sh --env /path/to/.env # use a different .env file
```

The script aborts on the first SQL error (`psql -v ON_ERROR_STOP=1`) and wraps
the schema and data files in single transactions, so a partial restore can't
leave the DB in a half-broken state.

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
