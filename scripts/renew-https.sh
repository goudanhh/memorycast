#!/usr/bin/env bash
set -euo pipefail
docker run --rm   -v "$(pwd)/certbot/conf:/etc/letsencrypt"   -v "$(pwd)/certbot/www:/var/www/certbot"   certbot/certbot:latest renew --webroot --webroot-path=/var/www/certbot
docker compose exec -T gateway nginx -s reload
