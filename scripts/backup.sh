#!/usr/bin/env bash
set -euo pipefail
mkdir -p backups
source .env
STAMP=$(date +%Y%m%d_%H%M%S)
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-memorycast}" "${POSTGRES_DB:-memorycast}" | gzip > "backups/memorycast_${STAMP}.sql.gz"
echo "Backup written: backups/memorycast_${STAMP}.sql.gz"
