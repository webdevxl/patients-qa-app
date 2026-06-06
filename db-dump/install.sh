#!/usr/bin/env bash
#
# install.sh — Restore the patients-qa Postgres database from this dump.
#
# Loads, in order:
#   1) schema.sql       — DDL only (extension, tables, indexes, foreign keys)
#   2) data.sql         — All row data; embeddings excluded from allergen + icd_code
#   3) embeddings.sql   — pgvector embeddings for allergen + icd_code (UPDATE-in-place)
#
# Three execution modes:
#
#   (default)   Local: use host psql against DATABASE_URL read from a .env file.
#               Good for: dev laptops, servers with postgresql-client installed.
#
#   --docker    Docker: pipe each SQL file into `docker exec -i <container> psql`.
#               Good for: servers where the DB runs in a container and you don't
#               want to install psql on the host. Defaults to the
#               `patients-qa-db` container (set by docker-compose.yml).
#
#   --compose   Compose: same as --docker but via `docker compose exec -T <svc>`.
#               Good for: when the container name isn't fixed and you want to go
#               through the compose project.
#
# The dump uses Postgres-16 \restrict meta-commands, so the target must be
# Postgres 16+ with the `vector` extension available (e.g. pgvector/pgvector:pg16).
#

set -euo pipefail

# SCRIPT_DIR is the absolute path of THIS script's directory, computed from
# BASH_SOURCE — not from $PWD. That's why running this from any working
# directory works: every default path below is anchored to SCRIPT_DIR, never to
# wherever you cd'd before invoking it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT_DIR is the canonical parent — assumed to be the repo root containing
# backend/ and docker-compose.yml (the project layout these dumps come from).
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

MODE="local"

# local-mode defaults
# Single source of truth: project root /.env (see /.env.example). There are no
# per-app env files anymore.
ENV_FILE="${PROJECT_DIR}/.env"

# docker / compose mode defaults — match docker-compose.yml
CONTAINER="patients-qa-db"
COMPOSE_SERVICE="db"
# Default to the sibling docker-compose.yml if present; falls back to letting
# `docker compose` find one in $PWD when this file is missing.
if [[ -f "${PROJECT_DIR}/docker-compose.yml" ]]; then
    COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"
else
    COMPOSE_FILE=""
fi
DB_USER="postgres"
DB_NAME="patients_qa"

SKIP_EMBEDDINGS=0
ASSUME_YES=0

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Execution modes:
  (default)               Local mode — host psql against DATABASE_URL.
  --docker                Docker mode — docker exec -i into a container.
  --compose               Compose mode — docker compose exec -T into a service.

Common options:
  --skip-embeddings       Restore schema + data only (skip embeddings.sql).
  -y, --yes               Don't prompt before applying (schema.sql DROPs tables).
  -h, --help              Show this help.

Local-mode options:
  --env <path>            Path to a .env file with DATABASE_URL.
                          Default: ${ENV_FILE}

Docker-mode options:
  --container <name>      Container running Postgres.
                          Default: ${CONTAINER}
  --db-user <user>        Postgres user inside the container (default: ${DB_USER}).
  --db-name <name>        Database inside the container (default: ${DB_NAME}).

Compose-mode options:
  --service <name>        Compose service name (default: ${COMPOSE_SERVICE}).
  --compose-file <path>   Path to docker-compose.yml.
                          Default: ${COMPOSE_FILE:-none, falls back to PWD}
  --db-user <user>        Postgres user (default: ${DB_USER}).
  --db-name <name>        Database name (default: ${DB_NAME}).

Examples:
  # Server with docker compose: bring up the DB and restore via the container
  docker compose up -d db
  ./install.sh --docker -y

  # Server with docker compose, going through the compose project:
  ./install.sh --compose --compose-file ../docker-compose.yml -y

  # Dev laptop with psql installed:
  ./install.sh                                # uses /.env at the repo root
  ./install.sh --env /path/to/.env

WARNING: schema.sql begins with DROP TABLE IF EXISTS … so existing data in the
target database will be wiped. Point this at the right database.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker)           MODE="docker"; shift ;;
        --compose)          MODE="compose"; shift ;;
        --env)              ENV_FILE="$2"; shift 2 ;;
        --container)        CONTAINER="$2"; shift 2 ;;
        --service)          COMPOSE_SERVICE="$2"; shift 2 ;;
        --compose-file)     COMPOSE_FILE="$2"; shift 2 ;;
        --db-user)          DB_USER="$2"; shift 2 ;;
        --db-name)          DB_NAME="$2"; shift 2 ;;
        --skip-embeddings)  SKIP_EMBEDDINGS=1; shift ;;
        -y|--yes)           ASSUME_YES=1; shift ;;
        -h|--help)          usage; exit 0 ;;
        *)                  echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

# ── Mode setup ──────────────────────────────────────────────────────────────
#
# Each mode defines:
#   • target_label  — human-readable description of where we're loading into.
#   • psql_run …    — runs `psql …` against the target. Stdin of the call is
#                     forwarded into psql so we can pipe SQL files into it,
#                     which is what makes the docker/compose modes work without
#                     mounting files into the container.

case "${MODE}" in
    local)
        if ! command -v psql >/dev/null 2>&1; then
            echo "✗ psql not found on PATH. Install postgresql-client 16+ or run with --docker." >&2
            exit 1
        fi
        if [[ ! -f "${ENV_FILE}" ]]; then
            echo "✗ .env file not found at: ${ENV_FILE}" >&2
            echo "  Pass --env <path>, or use --docker / --compose to skip the .env" >&2
            echo "  requirement and run psql inside the DB container instead." >&2
            exit 1
        fi
        set -a
        # shellcheck disable=SC1090
        source "${ENV_FILE}"
        set +a
        if [[ -z "${DATABASE_URL:-}" ]]; then
            echo "✗ DATABASE_URL is not set in ${ENV_FILE}." >&2
            exit 1
        fi
        target_label="$(printf '%s' "${DATABASE_URL}" | sed -E 's#(://[^:@/]+):[^@]+@#\1:***@#')"
        psql_run() { psql "${DATABASE_URL}" "$@"; }
        ;;

    docker)
        if ! command -v docker >/dev/null 2>&1; then
            echo "✗ docker not found on PATH." >&2
            exit 1
        fi
        if ! docker ps --format '{{.Names}}' | grep -qx -- "${CONTAINER}"; then
            echo "✗ Container '${CONTAINER}' is not running." >&2
            echo "  Bring it up first, e.g.:  docker compose up -d db" >&2
            exit 1
        fi
        target_label="docker exec ${CONTAINER} → psql -U ${DB_USER} -d ${DB_NAME}"
        psql_run() {
            docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" "$@"
        }
        ;;

    compose)
        if ! command -v docker >/dev/null 2>&1; then
            echo "✗ docker not found on PATH." >&2
            exit 1
        fi
        # Use docker compose v2 (the `docker compose` plugin). v1 (`docker-compose`)
        # is unsupported here — it doesn't support `exec -T` consistently and is EOL.
        compose_args=()
        if [[ -n "${COMPOSE_FILE}" ]]; then
            if [[ ! -f "${COMPOSE_FILE}" ]]; then
                echo "✗ Compose file not found: ${COMPOSE_FILE}" >&2
                exit 1
            fi
            compose_args=(-f "${COMPOSE_FILE}")
        fi
        # Confirm the target service is actually running. `ps --services --status running`
        # returns service names with a running container.
        if ! docker compose "${compose_args[@]}" ps --status running --services 2>/dev/null \
                | grep -qx -- "${COMPOSE_SERVICE}"; then
            echo "✗ Compose service '${COMPOSE_SERVICE}' is not running." >&2
            echo "  Bring it up first, e.g.:  docker compose up -d ${COMPOSE_SERVICE}" >&2
            exit 1
        fi
        target_label="docker compose exec ${COMPOSE_SERVICE} → psql -U ${DB_USER} -d ${DB_NAME}"
        psql_run() {
            docker compose "${compose_args[@]}" exec -T "${COMPOSE_SERVICE}" \
                psql -U "${DB_USER}" -d "${DB_NAME}" "$@"
        }
        ;;

    *)
        echo "✗ Unknown mode: ${MODE}" >&2
        exit 2
        ;;
esac

# ── Dump-file presence checks ───────────────────────────────────────────────

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

echo "Mode    : ${MODE}"
echo "Target  : ${target_label}"
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

# ── Apply ───────────────────────────────────────────────────────────────────
#
# We pipe each SQL file into psql via stdin (instead of `-f`) because in docker
# and compose modes the file lives on the host filesystem, not inside the
# container. psql treats stdin and -f equivalently for COPY ... FROM stdin
# blocks, so pg_dump-style output works in either case.
#
# ON_ERROR_STOP=1 aborts on the first SQL error; --single-transaction wraps the
# file in BEGIN/COMMIT so a partial load can't leave the DB half-restored.
# embeddings.sql already has its own per-table BEGIN/COMMIT blocks, so we omit
# --single-transaction there to avoid pointless nesting.

echo "→ Applying schema.sql ..."
psql_run -v ON_ERROR_STOP=1 --no-psqlrc --single-transaction < "${SCHEMA_FILE}"

echo "→ Applying data.sql ..."
psql_run -v ON_ERROR_STOP=1 --no-psqlrc --single-transaction < "${DATA_FILE}"

if [[ "${SKIP_EMBEDDINGS}" -eq 0 ]]; then
    echo "→ Applying embeddings.sql ..."
    psql_run -v ON_ERROR_STOP=1 --no-psqlrc < "${EMBEDDINGS_FILE}"
fi

echo
echo "✓ Restore complete."
echo
echo "Quick sanity check:"
psql_run --no-psqlrc -c "
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
