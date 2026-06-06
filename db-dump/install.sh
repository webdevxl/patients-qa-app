#!/usr/bin/env bash
#
# install.sh — Restore the patients-qa Postgres database from this dump.
#
# Loads, in order:
#   1) schema.sql       — DDL only (extension, tables, indexes, foreign keys)
#   2) data.sql         — All row data; embeddings excluded from allergen + icd_code
#   3) embeddings.sql   — pgvector embeddings for allergen + icd_code (UPDATE-in-place)
#
# Connection string is read from a .env file (DATABASE_URL=...). Default location
# is ../backend/.env relative to this script; override with --env <path>.
#
# Required on the target machine: psql 16+ (the dump uses Postgres-16 \restrict
# meta-commands), and a reachable Postgres 16 server with the `vector` extension
# available (i.e. pgvector installed; e.g. the pgvector/pgvector:pg16 image).
#

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../backend/.env"
SKIP_EMBEDDINGS=0
ASSUME_YES=0

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --env <path>        Path to the .env file holding DATABASE_URL.
                      Default: ${ENV_FILE}
  --skip-embeddings   Restore schema + data only (skip embeddings.sql).
  -y, --yes           Don't prompt before applying (schema.sql DROPs existing tables).
  -h, --help          Show this help.

The .env file must define DATABASE_URL, e.g.:
  DATABASE_URL="postgresql://user:pass@host:5432/dbname"

WARNING: schema.sql begins with DROP TABLE IF EXISTS … so existing data in the
target database will be wiped. Point this at the right database.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            ENV_FILE="$2"
            shift 2
            ;;
        --skip-embeddings)
            SKIP_EMBEDDINGS=1
            shift
            ;;
        -y|--yes)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if ! command -v psql >/dev/null 2>&1; then
    echo "✗ psql not found on PATH. Install postgresql-client 16+ and retry." >&2
    exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
    echo "✗ .env file not found at: ${ENV_FILE}" >&2
    echo "  Pass --env <path> to point at the right file." >&2
    exit 1
fi

# Source the .env file into the current shell. Lines like
#   DATABASE_URL="postgresql://..."
# work as-is; comments and blanks are ignored. We only export DATABASE_URL —
# psql discovers it via the positional connection string argument below.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "✗ DATABASE_URL is not set in ${ENV_FILE}." >&2
    exit 1
fi

SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"
DATA_FILE="${SCRIPT_DIR}/data.sql"
EMBEDDINGS_FILE="${SCRIPT_DIR}/embeddings.sql"

for f in "${SCHEMA_FILE}" "${DATA_FILE}"; do
    if [[ ! -f "${f}" ]]; then
        echo "✗ Missing dump file: ${f}" >&2
        exit 1
    fi
done
if [[ "${SKIP_EMBEDDINGS}" -eq 0 && ! -f "${EMBEDDINGS_FILE}" ]]; then
    echo "✗ Missing dump file: ${EMBEDDINGS_FILE}" >&2
    echo "  Pass --skip-embeddings to restore schema + data only." >&2
    exit 1
fi

# Hide the password before echoing the target. postgresql:// URLs look like
#   postgresql://user:pass@host:port/db?params  — strip the :pass part.
masked_url() {
    printf '%s' "$1" | sed -E 's#(://[^:@/]+):[^@]+@#\1:***@#'
}

echo "Target  : $(masked_url "${DATABASE_URL}")"
echo "Schema  : ${SCHEMA_FILE}"
echo "Data    : ${DATA_FILE}"
if [[ "${SKIP_EMBEDDINGS}" -eq 0 ]]; then
    echo "Vectors : ${EMBEDDINGS_FILE}"
else
    echo "Vectors : (skipped)"
fi
echo

if [[ "${ASSUME_YES}" -ne 1 ]]; then
    read -r -p "schema.sql will DROP existing tables in the target database. Continue? [y/N] " reply
    case "${reply}" in
        y|Y|yes|YES) ;;
        *) echo "Aborted." ; exit 1 ;;
    esac
fi

# ON_ERROR_STOP=1 makes psql abort the script on the first failure rather than
# plowing through. --single-transaction wraps each file in BEGIN/COMMIT so a
# half-loaded state is impossible (embeddings.sql already has its own BEGIN /
# COMMIT blocks; --single-transaction is still safe — psql nests them).
PSQL_OPTS=(-v ON_ERROR_STOP=1 --no-psqlrc --single-transaction)

echo "→ Applying schema.sql ..."
psql "${DATABASE_URL}" "${PSQL_OPTS[@]}" -f "${SCHEMA_FILE}"

echo "→ Applying data.sql ..."
psql "${DATABASE_URL}" "${PSQL_OPTS[@]}" -f "${DATA_FILE}"

if [[ "${SKIP_EMBEDDINGS}" -eq 0 ]]; then
    echo "→ Applying embeddings.sql ..."
    # embeddings.sql wraps each vocab table in its own BEGIN/COMMIT (so a failure
    # in icd_code doesn't roll back the allergen embeddings). Don't wrap the whole
    # file in another transaction here.
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 --no-psqlrc -f "${EMBEDDINGS_FILE}"
fi

echo
echo "✓ Restore complete."
echo
echo "Quick sanity check:"
psql "${DATABASE_URL}" --no-psqlrc -c "
  SELECT 'patient'                     AS table_name, COUNT(*) AS rows FROM public.patient
  UNION ALL SELECT 'patient_allergy',     COUNT(*) FROM public.patient_allergy
  UNION ALL SELECT 'allergen',            COUNT(*) FROM public.allergen
  UNION ALL SELECT 'allergen (embedded)', COUNT(*) FROM public.allergen     WHERE embedding IS NOT NULL
  UNION ALL SELECT 'patient_condition',   COUNT(*) FROM public.patient_condition
  UNION ALL SELECT 'patient_medication',  COUNT(*) FROM public.patient_medication
  UNION ALL SELECT 'patient_observation', COUNT(*) FROM public.patient_observation
  UNION ALL SELECT 'icd_code',            COUNT(*) FROM public.icd_code
  UNION ALL SELECT 'icd_code (embedded)', COUNT(*) FROM public.icd_code     WHERE embedding IS NOT NULL
  UNION ALL SELECT 'request_log',         COUNT(*) FROM public.request_log;
"
