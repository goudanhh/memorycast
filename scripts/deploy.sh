#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "Edit .env first, then run: ./scripts/deploy.sh"
  exit 1
fi

mkdir -p certbot/conf certbot/www backups
docker compose pull db web gateway
docker compose build api
docker compose up -d

echo
echo "MemoryCast is starting."
echo "Check: docker compose ps"
echo "Logs:  docker compose logs -f --tail=100"
echo
grep '^PUBLIC_URL=' .env || true
