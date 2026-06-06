#!/usr/bin/env bash
#
# dump.sh — Regenerate schema.sql, data.sql, and embeddings.sql from a running
# patients-qa Postgres database.
#
# Defaults to the local docker-compose container (`patients-qa-db`), which keeps
# the dumped pg_dump version aligned with the server version. Override with
# --container <name> or --db-url <url> to dump from a different source.
#

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="patients-qa-db"
DB_USER="postgres"
DB_NAME="patients_qa"
DB_URL=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --container <name>  Docker container running Postgres (default: ${CONTAINER}).
  --db-user <user>    Postgres user (default: ${DB_USER}).
  --db-name <name>    Database name (default: ${DB_NAME}).
  --db-url <url>      Dump from this URL instead of docker exec (uses host
                      pg_dump + psql; must be version 16+).
  -h, --help          Show this help.

Output files are written next to this script:
  schema.sql, data.sql, embeddings.sql
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --container) CONTAINER="$2"; shift 2 ;;
        --db-user)   DB_USER="$2"; shift 2 ;;
        --db-name)   DB_NAME="$2"; shift 2 ;;
        --db-url)    DB_URL="$2"; shift 2 ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

SCHEMA_OUT="${SCRIPT_DIR}/schema.sql"
DATA_OUT="${SCRIPT_DIR}/data.sql"
EMBED_OUT="${SCRIPT_DIR}/embeddings.sql"

if [[ -n "${DB_URL}" ]]; then
    pg_dump_cmd=(pg_dump "${DB_URL}")
    psql_cmd=(psql "${DB_URL}")
else
    pg_dump_cmd=(docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}")
    psql_cmd=(docker exec "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}")
fi

echo "→ Dumping schema → ${SCHEMA_OUT}"
"${pg_dump_cmd[@]}" --schema-only --no-owner --no-privileges --clean --if-exists > "${SCHEMA_OUT}"

echo "→ Dumping data (excluding allergen + icd_code) → ${DATA_OUT}"
"${pg_dump_cmd[@]}" --data-only --no-owner --no-privileges \
    --exclude-table=public.allergen \
    --exclude-table=public.icd_code \
    --disable-triggers \
    > "${DATA_OUT}"

echo "→ Appending allergen + icd_code (embedding column excluded) to data.sql"
{
    cat <<'HEADER'


--
-- Manual COPY blocks for the embedding-bearing vocabulary tables.
-- Their embedding column is intentionally excluded here — load it from
-- embeddings.sql afterwards.
--

COPY public.allergen (id, canonical_name, category, created_time) FROM stdin;
HEADER
    "${psql_cmd[@]}" -c "\copy (SELECT id, canonical_name, category, created_time FROM public.allergen ORDER BY id) TO stdout"
    cat <<'MID'
\.


COPY public.icd_code (code, description, created_time) FROM stdin;
MID
    "${psql_cmd[@]}" -c "\copy (SELECT code, description, created_time FROM public.icd_code ORDER BY code) TO stdout"
    cat <<'FOOTER'
\.

--
-- End manual COPY blocks.
--
FOOTER
} >> "${DATA_OUT}"

echo "→ Dumping embeddings → ${EMBED_OUT}"
{
    cat <<'HEADER'
--
-- Embeddings dump for the patients-qa Postgres database.
--
-- Two pgvector columns are restored here:
--   • public.allergen.embedding  (vector(1536))
--   • public.icd_code.embedding  (vector(1536))
--
-- Run AFTER schema.sql + data.sql. The schema script creates the columns and the
-- data script seeds the parent rows (without embeddings); this file backfills
-- them by COPYing into a temp table and UPDATEing in place. Safe to re-run.
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

--
-- allergen.embedding
--

BEGIN;

CREATE TEMP TABLE _allergen_embedding_load (
    id        text PRIMARY KEY,
    embedding public.vector(1536) NOT NULL
) ON COMMIT DROP;

COPY _allergen_embedding_load (id, embedding) FROM stdin;
HEADER
    "${psql_cmd[@]}" -c "\copy (SELECT id, embedding::text FROM public.allergen WHERE embedding IS NOT NULL ORDER BY id) TO stdout"
    cat <<'MID'
\.

UPDATE public.allergen a
   SET embedding = e.embedding
  FROM _allergen_embedding_load e
 WHERE a.id = e.id;

COMMIT;

--
-- icd_code.embedding
--

BEGIN;

CREATE TEMP TABLE _icd_code_embedding_load (
    code      text PRIMARY KEY,
    embedding public.vector(1536) NOT NULL
) ON COMMIT DROP;

COPY _icd_code_embedding_load (code, embedding) FROM stdin;
MID
    "${psql_cmd[@]}" -c "\copy (SELECT code, embedding::text FROM public.icd_code WHERE embedding IS NOT NULL ORDER BY code) TO stdout"
    cat <<'FOOTER'
\.

UPDATE public.icd_code i
   SET embedding = e.embedding
  FROM _icd_code_embedding_load e
 WHERE i.code = e.code;

COMMIT;

--
-- Embedding restore complete.
--
FOOTER
} > "${EMBED_OUT}"

echo
echo "✓ Dump complete:"
ls -lh "${SCHEMA_OUT}" "${DATA_OUT}" "${EMBED_OUT}"
